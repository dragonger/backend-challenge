import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Where an operation came from; used as a label. */
export type Channel = 'http' | 'sqs' | 'worker';

/**
 * Prometheus metrics with a registry of our own (never the global default one,
 * so tests and several app instances in one process do not collide). The
 * registry is exposed on GET /metrics.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly reconciliationMismatches = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Reconciliations where the stored balance differs from the ledger',
    registers: [this.registry],
  });

  readonly wagerTransactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions resolved, by kind, final status and channel',
    labelNames: ['kind', 'status', 'channel'] as const,
    registers: [this.registry],
  });

  readonly idempotentReplays = new Counter({
    name: 'idempotent_replays_total',
    help: 'Duplicates answered with the original result',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly idempotencyConflicts = new Counter({
    name: 'idempotency_conflicts_total',
    help: 'Idempotency key (or provider id) reused with a different payload',
    registers: [this.registry],
  });

  readonly sqsMessages = new Counter({
    name: 'sqs_messages_total',
    help: 'SQS messages handled, by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'Messages left on the queue for a later retry (transient failure)',
    registers: [this.registry],
  });

  readonly sqsDlq = new Counter({
    name: 'sqs_dlq_total',
    help: 'Messages sent to the dead-letter queue by the consumer, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Lock timeouts and deadlocks detected by PostgreSQL',
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events published to the events queue',
    registers: [this.registry],
  });

  readonly outboxPublishFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox events whose publication failed (will be retried with backoff)',
    registers: [this.registry],
  });

  readonly outboxLagSeconds = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event (0 when empty)',
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Unpublished outbox events',
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Time to process a wager transaction (whole SQL transaction included)',
    labelNames: ['channel'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  constructor() {
    try {
      collectDefaultMetrics({ register: this.registry });
    } catch {
      // Runtime without some process introspection API: business metrics still work.
    }
  }
}
