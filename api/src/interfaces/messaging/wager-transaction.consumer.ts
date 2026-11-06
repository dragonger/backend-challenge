import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import {
  backgroundWorkerDefault,
  boolFromEnv,
  intFromEnv,
} from '../../config/env.js';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.usecase.js';
import { MetricsService } from '../../infrastructure/metrics/metrics.service.js';
import { bindContext, runWithContext } from '../../infrastructure/observability/request-context.js';
import { SqsService } from '../../infrastructure/sqs/sqs.service.js';
import { classifyError, retryDelaySeconds, type ErrorClass } from './message-classifier.js';
import { parseWagerMessage, toCommand } from './wager-message.js';

export const CONSUMER_CONFIG = Symbol('CONSUMER_CONFIG');

export interface ConsumerConfig {
  enabled: boolean;
  /** Maximum messages being processed at the same time. */
  concurrency: number;
  /** Long polling wait (seconds, 0..20). Also the worst-case shutdown latency. */
  waitTimeSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  /** Mirrors the queue redrive policy; only used to log/count the last attempt. */
  maxReceiveCount: number;
  /**
   * TEST SEAM. When true (only possible with NODE_ENV=test and
   * TEST_CRASH_AFTER_COMMIT=1) the process dies right after the SQL commit and
   * before the ack, reproducing "worker killed between commit and ack".
   */
  crashAfterCommit: boolean;
}

export function consumerConfigFromEnv(): ConsumerConfig {
  const waitTimeSeconds = Number(process.env.SQS_WAIT_TIME_SECONDS ?? 5);

  if (!Number.isInteger(waitTimeSeconds) || waitTimeSeconds < 0 || waitTimeSeconds > 20) {
    throw new Error('Invalid numeric environment variable: SQS_WAIT_TIME_SECONDS');
  }

  return {
    enabled: boolFromEnv('SQS_CONSUMER_ENABLED', backgroundWorkerDefault()),
    concurrency: intFromEnv('SQS_CONSUMER_CONCURRENCY', 10),
    waitTimeSeconds,
    retryBaseSeconds: intFromEnv('SQS_RETRY_BASE_SECONDS', 2),
    retryMaxSeconds: intFromEnv('SQS_RETRY_MAX_SECONDS', 60),
    maxReceiveCount: intFromEnv('SQS_MAX_RECEIVE_COUNT', 5),
    crashAfterCommit:
      process.env.NODE_ENV === 'test' && process.env.TEST_CRASH_AFTER_COMMIT === '1',
  };
}

const MAX_BATCH = 10;

/**
 * Consumes `wager-transactions.fifo` with long polling and calls the SAME
 * ProcessWagerTransaction use case as HTTP, passing the inbox identity so the
 * message is deduplicated inside the business transaction.
 *
 * Ack rules (DeleteMessage):
 *  - only AFTER the use case committed (or the result is terminal);
 *  - business result (processed, rejected, pending, replay, idempotency
 *    conflict, unknown wallet): ack;
 *  - transient failure: no ack, ChangeMessageVisibility with exponential
 *    backoff from ApproximateReceiveCount; the queue redrive policy moves the
 *    message to the DLQ when maxReceiveCount is exhausted;
 *  - permanent failure (malformed, unknown type, invalid command): copy to the
 *    DLQ with the reason as a message attribute, then delete from the queue.
 *
 * FIFO detail: messages of one MessageGroupId (the wallet) in the same batch
 * are handled in order; when one is not settled the rest of its group is
 * released untouched so ordering is preserved.
 *
 * Shutdown (onModuleDestroy, before the ORM closes): stop fetching, release
 * (visibility 0) the received-but-not-started messages, wait for the ones in
 * progress.
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly tasks = new Set<Promise<void>>();
  private inFlight = 0;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly sqs: SqsService,
    private readonly processor: ProcessWagerTransaction,
    private readonly metrics: MetricsService,
    @Inject(CONSUMER_CONFIG) private readonly config: ConsumerConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.enabled) {
      this.start();
    } else {
      this.logger.log('SQS consumer disabled (SQS_CONSUMER_ENABLED=false)');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.loop) {
      return;
    }

    this.stopping = false;
    this.loop = this.pollLoop();
    this.logger.log(
      `SQS consumer started (concurrency ${this.config.concurrency}, wait ${this.config.waitTimeSeconds}s)`,
    );
  }

  /** Graceful stop: resolves when nothing is in progress anymore. */
  async stop(): Promise<void> {
    if (!this.loop) {
      return;
    }

    this.stopping = true;
    this.wake?.();
    await this.loop;
    await Promise.allSettled(this.tasks);
    this.loop = undefined;
    this.logger.log('SQS consumer stopped');
  }

  // ---------------------------------------------------------------- polling

  private async pollLoop(): Promise<void> {
    let failures = 0;

    while (!this.stopping) {
      const free = this.config.concurrency - this.inFlight;

      if (free <= 0) {
        await this.waitForSlot();
        continue;
      }

      let messages: Message[];

      try {
        messages = await this.receive(Math.min(MAX_BATCH, free));
        failures = 0;
      } catch (error) {
        failures += 1;
        this.logger.warn(
          `ReceiveMessage failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.sleep(Math.min(5000, 250 * 2 ** Math.min(failures, 5)));
        continue;
      }

      if (messages.length > 0) {
        this.dispatch(messages);
      }
    }
  }

  private async receive(max: number): Promise<Message[]> {
    const QueueUrl = await this.sqs.queueUrl(this.sqs.config.queueName);
    // The request must outlive the long poll; it is NOT aborted on shutdown
    // (that could drop messages the server already handed over).
    const output = await this.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: this.config.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: AbortSignal.timeout(this.config.waitTimeSeconds * 1000 + 10_000) },
    );

    return output.Messages ?? [];
  }

  /** Groups run concurrently; messages inside a group run in order. */
  private dispatch(messages: Message[]): void {
    const groups = new Map<string, Message[]>();

    for (const message of messages) {
      const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? crypto.randomUUID();
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }

    for (const group of groups.values()) {
      this.inFlight += group.length;

      const task: Promise<void> = this.processGroup(group)
        .catch((error: unknown) => {
          this.logger.error(`Unexpected consumer failure: ${String(error)}`);
        })
        .finally(() => {
          this.tasks.delete(task);
          this.inFlight -= group.length;
          this.wake?.();
        });

      this.tasks.add(task);
    }
  }

  private async processGroup(group: Message[]): Promise<void> {
    let settled = true;

    for (const message of group) {
      if (this.stopping || !settled) {
        await this.release(message);
        continue;
      }

      settled = await this.handle(message);
    }
  }

  // --------------------------------------------------------------- handling

  /** Returns true when the message is finished (acked / dead-lettered). */
  private handle(message: Message): Promise<boolean> {
    return runWithContext({}, async () => {
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);

      try {
        const parsed = parseWagerMessage(message.Body);

        bindContext({
          messageId: parsed.message.messageId,
          correlationId: parsed.message.messageId,
          providerId: parsed.message.data.providerId,
          walletId: parsed.message.data.walletId,
        });

        const result = await this.processor.execute(toCommand(parsed));

        if (this.config.crashAfterCommit) {
          // Test seam: committed, not acked. See ConsumerConfig.crashAfterCommit.
          process.exit(1);
        }

        const outcome = result.idempotentReplay
          ? 'replay'
          : result.status === 'PROCESSED'
            ? 'processed'
            : result.status === 'REJECTED'
              ? 'rejected'
              : 'pending_reference';

        this.metrics.sqsMessages.inc({ outcome });
        this.logger.log(
          `message ${outcome} (status ${result.status}${result.failureCode ? `, ${result.failureCode}` : ''}, receive ${receiveCount})`,
        );
        await this.ack(message);

        return true;
      } catch (error) {
        return this.onFailure(message, receiveCount, error);
      }
    });
  }

  private async onFailure(
    message: Message,
    receiveCount: number,
    error: unknown,
  ): Promise<boolean> {
    const classified = classifyError(error);

    if (classified.kind === 'business') {
      this.metrics.sqsMessages.inc({ outcome: classified.outcome });
      this.logger.warn(`message ${classified.outcome}: acked (${describe(error)})`);
      await this.ack(message);

      return true;
    }

    if (classified.kind === 'permanent') {
      try {
        await this.deadLetter(message, classified, receiveCount);

        return true;
      } catch (dlqError) {
        // Could not park it: fall through to the retry path, never lose it.
        this.logger.error(`DLQ hand-over failed: ${describe(dlqError)}`);
      }
    }

    await this.scheduleRetry(message, receiveCount, error);

    return false;
  }

  private async scheduleRetry(
    message: Message,
    receiveCount: number,
    error: unknown,
  ): Promise<void> {
    const delay = retryDelaySeconds(receiveCount, {
      baseSeconds: this.config.retryBaseSeconds,
      maxSeconds: this.config.retryMaxSeconds,
    });

    this.metrics.sqsRetries.inc();
    this.metrics.sqsMessages.inc({ outcome: 'retried' });

    if (receiveCount >= this.config.maxReceiveCount) {
      // The next receive exceeds maxReceiveCount: SQS redrives it to the DLQ.
      this.metrics.sqsDlq.inc({ reason: 'MAX_RECEIVE_COUNT' });
      this.logger.error(
        `message failed on its last attempt (${receiveCount}/${this.config.maxReceiveCount}); the redrive policy moves it to the DLQ: ${describe(error)}`,
      );
    } else {
      this.logger.warn(
        `transient failure on attempt ${receiveCount}; retry in ~${delay}s: ${describe(error)}`,
      );
    }

    try {
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await this.sqs.queueUrl(this.sqs.config.queueName),
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delay,
        }),
        { abortSignal: this.sqs.timeoutSignal() },
      );
    } catch (visibilityError) {
      // Worst case the message reappears when its original timeout expires.
      this.logger.warn(`ChangeMessageVisibility failed: ${describe(visibilityError)}`);
    }
  }

  private async deadLetter(
    message: Message,
    failure: Extract<ErrorClass, { kind: 'permanent' }>,
    receiveCount: number,
  ): Promise<void> {
    const dlqUrl = await this.sqs.queueUrl(this.sqs.config.dlqName);

    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
        // The SQS message id is stable across redeliveries: a repeated hand-over dedups.
        MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
        MessageAttributes: {
          FailureReason: { DataType: 'String', StringValue: failure.reason },
          FailureDetail: { DataType: 'String', StringValue: failure.detail.slice(0, 500) },
          OriginalSqsMessageId: { DataType: 'String', StringValue: message.MessageId ?? '' },
          ReceiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
        },
      }),
      { abortSignal: this.sqs.timeoutSignal() },
    );

    this.metrics.sqsDlq.inc({ reason: failure.reason });
    this.metrics.sqsMessages.inc({ outcome: 'dead_lettered' });
    this.logger.error(`message sent to DLQ (${failure.reason}): ${failure.detail}`);
    await this.ack(message);
  }

  /** DeleteMessage. Failure is harmless: the redelivery is deduplicated by the inbox. */
  private async ack(message: Message): Promise<void> {
    try {
      await this.sqs.client.send(
        new DeleteMessageCommand({
          QueueUrl: await this.sqs.queueUrl(this.sqs.config.queueName),
          ReceiptHandle: message.ReceiptHandle,
        }),
        { abortSignal: this.sqs.timeoutSignal() },
      );
    } catch (error) {
      this.logger.warn(`DeleteMessage failed (will be redelivered and deduplicated): ${describe(error)}`);
    }
  }

  /** Gives a received-but-untouched message back immediately. */
  private async release(message: Message): Promise<void> {
    this.metrics.sqsMessages.inc({ outcome: 'released' });

    try {
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await this.sqs.queueUrl(this.sqs.config.queueName),
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
        { abortSignal: this.sqs.timeoutSignal() },
      );
    } catch (error) {
      this.logger.warn(`release failed (visibility timeout will expire): ${describe(error)}`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve();
      };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };

      timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);
}
