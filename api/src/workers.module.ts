import { Module } from '@nestjs/common';

import { OUTBOX_CONFIG, OutboxPublisher, outboxConfigFromEnv } from './infrastructure/outbox/outbox-publisher.js';
import { SqsModule } from './infrastructure/sqs/sqs.module.js';
import {
  PENDING_WORKER_CONFIG,
  PendingReferenceWorker,
  pendingWorkerConfigFromEnv,
} from './infrastructure/workers/pending-reference.worker.js';
import {
  CONSUMER_CONFIG,
  WagerTransactionConsumer,
  consumerConfigFromEnv,
} from './interfaces/messaging/wager-transaction.consumer.js';
import { WageringModule } from './wagering.module.js';

/**
 * Background work of every instance: the SQS consumer, the outbox publisher
 * and the pending-reference worker. Each one is switched on by its own env
 * flag (SQS_CONSUMER_ENABLED, OUTBOX_PUBLISHER_ENABLED, PENDING_WORKER_ENABLED)
 * so instances can be specialised; all default to on outside tests.
 */
@Module({
  imports: [WageringModule, SqsModule],
  providers: [
    { provide: CONSUMER_CONFIG, useFactory: consumerConfigFromEnv },
    { provide: OUTBOX_CONFIG, useFactory: outboxConfigFromEnv },
    { provide: PENDING_WORKER_CONFIG, useFactory: pendingWorkerConfigFromEnv },
    WagerTransactionConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
  ],
})
export class WorkersModule {}
