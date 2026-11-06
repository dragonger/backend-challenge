import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { ResolvePendingTransaction } from '../../application/wagering/resolve-pending-transaction.usecase.js';
import { backgroundWorkerDefault, boolFromEnv, intFromEnv } from '../../config/env.js';
import { PendingTransactionsRepository } from '../database/pending-transactions.repository.js';
import { runWithContext } from '../observability/request-context.js';
import { PollingLoop } from './polling-loop.js';

export const PENDING_WORKER_CONFIG = Symbol('PENDING_WORKER_CONFIG');

export interface PendingWorkerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  /** Due transactions fetched per cycle. */
  batchSize: number;
  /** Resolutions running at the same time inside one instance. */
  concurrency: number;
}

export function pendingWorkerConfigFromEnv(): PendingWorkerConfig {
  return {
    enabled: boolFromEnv('PENDING_WORKER_ENABLED', backgroundWorkerDefault()),
    pollIntervalMs: intFromEnv('PENDING_WORKER_INTERVAL_MS', 1000),
    batchSize: intFromEnv('PENDING_WORKER_BATCH_SIZE', 50),
    concurrency: intFromEnv('PENDING_WORKER_CONCURRENCY', 5),
  };
}

/**
 * Scheduled re-resolution of PENDING_REFERENCE transactions. Each cycle takes
 * the due ids (`FOR UPDATE SKIP LOCKED`, so several instances see disjoint
 * sets) and runs ResolvePendingTransaction for each. Correctness never depends
 * on the skip: the use case locks the wallet and re-reads the row, so a
 * concurrent resolver just sees NOT_PENDING.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private loop: PollingLoop | undefined;

  constructor(
    private readonly repository: PendingTransactionsRepository,
    private readonly resolver: ResolvePendingTransaction,
    @Inject(PENDING_WORKER_CONFIG) private readonly config: PendingWorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.enabled) {
      this.start();
    } else {
      this.logger.log('Pending worker disabled (PENDING_WORKER_ENABLED=false)');
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
      PendingReferenceWorker.name,
      async () => (await this.runOnce()) >= this.config.batchSize,
      this.config.pollIntervalMs,
    );
    this.loop.start();
    this.logger.log(`Pending worker started (poll ${this.config.pollIntervalMs}ms)`);
  }

  async stop(): Promise<void> {
    await this.loop?.stop();
    this.loop = undefined;
  }

  /** One cycle; returns how many due transactions were fetched. Public for tests. */
  async runOnce(): Promise<number> {
    const ids = await this.repository.findDueIds(this.config.batchSize);

    for (let start = 0; start < ids.length; start += this.config.concurrency) {
      await Promise.all(
        ids.slice(start, start + this.config.concurrency).map((id) => this.resolveOne(id)),
      );
    }

    return ids.length;
  }

  private resolveOne(id: string): Promise<void> {
    return runWithContext({}, async () => {
      try {
        const result = await this.resolver.execute(id);

        this.logger.log(`pending transaction ${result.outcome}`);
      } catch (error) {
        // Transient (lock timeout, DB down): the row stays due and is retried.
        this.logger.warn(
          `pending transaction ${id} not resolved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}
