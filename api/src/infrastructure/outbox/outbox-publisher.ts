import {
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { backgroundWorkerDefault, boolFromEnv, intFromEnv } from '../../config/env.js';
import { TransactionRunner } from '../database/transaction-runner.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { SqsService } from '../sqs/sqs.service.js';
import { PollingLoop } from '../workers/polling-loop.js';

export const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');

export interface OutboxConfig {
  enabled: boolean;
  /** Idle wait between polls, in ms. */
  pollIntervalMs: number;
  /** Rows locked and published per transaction. */
  batchSize: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How often the lag / pending gauges are refreshed. */
  gaugeIntervalMs: number;
}

export function outboxConfigFromEnv(): OutboxConfig {
  return {
    enabled: boolFromEnv('OUTBOX_PUBLISHER_ENABLED', backgroundWorkerDefault()),
    pollIntervalMs: intFromEnv('OUTBOX_POLL_INTERVAL_MS', 500),
    batchSize: intFromEnv('OUTBOX_BATCH_SIZE', 50),
    backoffBaseMs: intFromEnv('OUTBOX_BACKOFF_BASE_MS', 1000),
    backoffMaxMs: intFromEnv('OUTBOX_BACKOFF_MAX_MS', 60_000),
    gaugeIntervalMs: intFromEnv('OUTBOX_GAUGE_INTERVAL_MS', 2000),
  };
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

export interface PublishBatchResult {
  /** Rows locked by this call. */
  picked: number;
  published: number;
  failed: number;
}

/** SendMessageBatch accepts at most 10 entries. */
const SQS_BATCH_LIMIT = 10;

/** Exponential backoff with +/-20% jitter, capped. */
export function outboxBackoffMs(
  attempts: number,
  config: Pick<OutboxConfig, 'backoffBaseMs' | 'backoffMaxMs'>,
  random: () => number = Math.random,
): number {
  const raw = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** Math.min(attempts, 30));

  return Math.round(raw * (0.8 + 0.4 * random()));
}

/**
 * Transactional-outbox relay, one per app instance. Every cycle runs in ONE
 * SQL transaction:
 *
 *   SELECT ... FROM outbox_messages
 *    WHERE published_at IS NULL AND next_attempt_at <= now()
 *    ORDER BY sequence LIMIT n FOR UPDATE SKIP LOCKED
 *
 * then publishes the rows to the FIFO events queue (MessageGroupId =
 * aggregateId, MessageDeduplicationId = eventId, body = the envelope JSON) and
 * marks published_at. Concurrent publishers lock disjoint rows, so the same
 * row is never published by two of them at the same time. A failure bumps
 * `attempts`, stores `last_error` and reschedules with exponential backoff.
 *
 * Guarantee: AT LEAST ONCE. If the process dies after SendMessage and before
 * the commit, the row is still unpublished and another instance sends it again.
 * FIFO deduplication (same eventId within 5 minutes) absorbs most repeats and
 * consumers must deduplicate by eventId for the rest. Ordering per wallet is
 * best effort (sequence order inside a batch; a failed row is retried later).
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private loop: PollingLoop | undefined;
  private lastGaugeAt = 0;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly sqs: SqsService,
    private readonly metrics: MetricsService,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.enabled) {
      this.start();
    } else {
      this.logger.log('Outbox publisher disabled (OUTBOX_PUBLISHER_ENABLED=false)');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.loop) {
      return;
    }

    this.loop = new PollingLoop(
      OutboxPublisher.name,
      async () => {
        // Gauges first: they describe the backlog as found at the start of the
        // cycle (measuring after publishing would always show a drained queue).
        await this.refreshGauges();

        const result = await this.publishBatch();

        // A full batch means there is probably more: go again immediately.
        return result.picked >= this.config.batchSize;
      },
      this.config.pollIntervalMs,
    );
    this.loop.start();
    this.logger.log(
      `Outbox publisher started (batch ${this.config.batchSize}, poll ${this.config.pollIntervalMs}ms)`,
    );
  }

  async stop(): Promise<void> {
    await this.loop?.stop();
    this.loop = undefined;
  }

  /** One locked-publish-mark cycle. Public so tests can drive it. */
  publishBatch(): Promise<PublishBatchResult> {
    return this.runner.run(async (em) => {
      const rows = await em.execute<OutboxRow[]>(
        `select id, aggregate_id, event_type, payload, attempts
           from outbox_messages
          where published_at is null and next_attempt_at <= now()
          order by sequence
          limit ?
            for update skip locked`,
        [this.config.batchSize],
      );

      if (rows.length === 0) {
        return { picked: 0, published: 0, failed: 0 };
      }

      const errors = await this.send(rows);
      const publishedIds = rows.filter((row) => !errors.has(row.id)).map((row) => row.id);

      if (publishedIds.length > 0) {
        await em.execute(
          `update outbox_messages set published_at = now(), last_error = null where id in (?)`,
          [publishedIds],
        );
      }

      for (const row of rows) {
        const error = errors.get(row.id);

        if (error !== undefined) {
          const delayMs = outboxBackoffMs(row.attempts, this.config);

          await em.execute(
            `update outbox_messages
                set attempts = attempts + 1,
                    last_error = ?,
                    next_attempt_at = now() + make_interval(secs => ?::double precision)
              where id = ?`,
            [error.slice(0, 500), delayMs / 1000, row.id],
          );
        }
      }

      this.metrics.outboxPublished.inc(publishedIds.length);
      this.metrics.outboxPublishFailures.inc(errors.size);

      if (errors.size > 0) {
        this.logger.warn(
          `${errors.size} of ${rows.length} outbox events failed to publish; rescheduled with backoff`,
        );
      }

      return { picked: rows.length, published: publishedIds.length, failed: errors.size };
    });
  }

  /** Sends the rows and returns failures keyed by outbox id. */
  private async send(rows: OutboxRow[]): Promise<Map<string, string>> {
    const errors = new Map<string, string>();
    let queueUrl: string;

    try {
      queueUrl = await this.sqs.queueUrl(this.sqs.config.eventsQueueName);
    } catch (error) {
      for (const row of rows) {
        errors.set(row.id, messageOf(error));
      }

      return errors;
    }

    for (let start = 0; start < rows.length; start += SQS_BATCH_LIMIT) {
      const chunk = rows.slice(start, start + SQS_BATCH_LIMIT);
      const entries: SendMessageBatchRequestEntry[] = chunk.map((row, index) => ({
        Id: String(index),
        MessageBody: JSON.stringify(row.payload),
        MessageGroupId: row.aggregate_id,
        MessageDeduplicationId: row.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: row.event_type },
        },
      }));

      try {
        const output = await this.sqs.client.send(
          new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }),
          { abortSignal: AbortSignal.timeout(Math.max(this.sqs.config.requestTimeoutMs, 5000)) },
        );

        for (const failure of output.Failed ?? []) {
          const row = chunk[Number(failure.Id)];

          if (row) {
            errors.set(row.id, `${failure.Code ?? 'SendFailed'}: ${failure.Message ?? ''}`);
          }
        }
      } catch (error) {
        // Whole call failed (SQS unreachable): do not hammer it with the rest.
        for (const row of rows.slice(start)) {
          errors.set(row.id, messageOf(error));
        }

        return errors;
      }
    }

    return errors;
  }

  /** outbox_lag_seconds (age of the oldest pending event) and outbox_pending. */
  private async refreshGauges(): Promise<void> {
    const now = Date.now();

    if (now - this.lastGaugeAt < this.config.gaugeIntervalMs) {
      return;
    }

    this.lastGaugeAt = now;
    await this.updateGauges();
  }

  async updateGauges(): Promise<void> {
    const rows = await this.runner.read((em) =>
      em.execute<Array<{ pending: string; lag: string | null }>>(
        `select count(*)::text as pending,
                extract(epoch from now() - min(created_at))::text as lag
           from outbox_messages
          where published_at is null`,
      ),
    );

    this.metrics.outboxPending.set(Number(rows[0]?.pending ?? 0));
    this.metrics.outboxLagSeconds.set(Math.max(0, Number(rows[0]?.lag ?? 0)));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
