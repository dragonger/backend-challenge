import { randomBytes, randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

import type { SqsConfig } from '../../src/infrastructure/sqs/sqs.config.js';
import { sqsConfigFromEnv } from '../../src/infrastructure/sqs/sqs.config.js';
import { SqsService } from '../../src/infrastructure/sqs/sqs.service.js';

export interface QueueOptions {
  /** Visibility timeout of the work queue, in seconds. */
  visibilityTimeout?: number;
  /** Redrive threshold of the work queue. */
  maxReceiveCount?: number;
  /** Create the events queue now (false to test publishing without it). */
  createEvents?: boolean;
}

export interface WagerMessageInput {
  messageId: string;
  walletId: string;
  playerId: string;
  externalTransactionId: string;
  kind?: string;
  amount?: string;
  referenceExternalTransactionId?: string;
  providerId?: string;
  roundId?: string;
  /** Overrides for malformed-body tests. */
  raw?: string;
}

/**
 * A set of isolated queues (names with a per-run suffix) so tests never touch
 * the development queues. Created and deleted by the test itself.
 */
export class TestQueues {
  readonly client: SQSClient;
  readonly config: SqsConfig;
  readonly sqs: SqsService;
  readonly suffix = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  readonly mainName = `rt-wager-${this.suffix}.fifo`;
  readonly dlqName = `rt-dlq-${this.suffix}.fifo`;
  readonly eventsName = `rt-events-${this.suffix}.fifo`;
  mainUrl = '';
  dlqUrl = '';
  eventsUrl = '';

  private constructor() {
    const base = sqsConfigFromEnv();

    this.config = {
      ...base,
      queueName: this.mainName,
      dlqName: this.dlqName,
      eventsQueueName: this.eventsName,
      queueUrl: undefined,
      requestTimeoutMs: 5000,
    };
    this.sqs = new SqsService(this.config);
    this.client = this.sqs.client;
  }

  static async create(options: QueueOptions = {}): Promise<TestQueues> {
    const queues = new TestQueues();
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

    queues.dlqUrl = await queues.createQueue(queues.dlqName, fifo);

    const dlqArn = (
      await queues.client.send(
        new GetQueueAttributesCommand({ QueueUrl: queues.dlqUrl, AttributeNames: ['QueueArn'] }),
      )
    ).Attributes?.QueueArn;

    queues.mainUrl = await queues.createQueue(queues.mainName, {
      ...fifo,
      VisibilityTimeout: String(options.visibilityTimeout ?? 30),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(options.maxReceiveCount ?? 5),
      }),
    });

    if (options.createEvents !== false) {
      await queues.createEventsQueue();
    }

    return queues;
  }

  async createEventsQueue(): Promise<void> {
    this.eventsUrl = await this.createQueue(this.eventsName, {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
    });
  }

  private async createQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const output = await this.client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );

    if (!output.QueueUrl) {
      throw new Error(`Queue ${name} was not created`);
    }

    return output.QueueUrl;
  }

  /** Environment for a child process to use these queues. */
  env(): Record<string, string> {
    return {
      SQS_QUEUE_NAME: this.mainName,
      SQS_DLQ_NAME: this.dlqName,
      SQS_EVENTS_QUEUE_NAME: this.eventsName,
      SQS_QUEUE_URL: this.mainUrl,
    };
  }

  /** Sends wager messages in batches of 10 (group = wallet, dedup = messageId + nonce). */
  async send(messages: WagerMessageInput[], distinctDeliveries = false): Promise<void> {
    for (let start = 0; start < messages.length; start += 10) {
      const chunk = messages.slice(start, start + 10);

      await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.mainUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: message.raw ?? bodyOf(message),
            MessageGroupId: message.walletId,
            // Same dedup id would make SQS itself drop the second copy; tests
            // that simulate redelivery/duplicates need both to be accepted.
            MessageDeduplicationId: distinctDeliveries
              ? `${message.messageId}-${randomUUID()}`
              : message.messageId,
          })),
        }),
      );
    }
  }

  /** Visible + in flight + delayed messages in the work queue. */
  async depth(url: string = this.mainUrl): Promise<number> {
    const attributes =
      (
        await this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
              'ApproximateNumberOfMessagesDelayed',
            ],
          }),
        )
      ).Attributes ?? {};

    return (
      Number(attributes.ApproximateNumberOfMessages ?? 0) +
      Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0) +
      Number(attributes.ApproximateNumberOfMessagesDelayed ?? 0)
    );
  }

  /** Receives and deletes everything currently reachable in a queue. */
  async drain(url: string, waitSeconds = 1, rounds = 20): Promise<Message[]> {
    const collected: Message[] = [];
    let empty = 0;

    for (let round = 0; round < rounds && empty < 2; round += 1) {
      const output = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: waitSeconds,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      const messages = output.Messages ?? [];

      empty = messages.length === 0 ? empty + 1 : 0;

      for (const message of messages) {
        collected.push(message);
        await this.client.send(
          new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }

    return collected;
  }

  async destroy(): Promise<void> {
    for (const url of [this.mainUrl, this.dlqUrl, this.eventsUrl]) {
      if (url) {
        await this.client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
      }
    }

    this.sqs.onApplicationShutdown();
  }
}

export function bodyOf(input: WagerMessageInput): string {
  return JSON.stringify({
    messageId: input.messageId,
    type: 'WagerTransactionRequested',
    // Fixed on purpose: a redelivered / duplicated message must be byte-identical.
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: input.providerId ?? 'provider-a',
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: `${input.providerId ?? 'provider-a'}:${input.externalTransactionId}`,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: input.kind ?? 'BET',
      money: { amount: input.amount ?? '10.00', currency: 'BRL' },
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    },
  });
}
