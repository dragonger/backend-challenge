import { Inject, Injectable, Optional } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { toTransientIfNeeded } from './transient-errors.js';

const LOCK_CONFLICT_STATES = new Set(['55P03', '40P01']);

export const LOCK_TIMEOUT_MS = Symbol('LOCK_TIMEOUT_MS');

/**
 * Runs a unit of work in its own forked EntityManager and its own SQL
 * transaction (one pooled connection per operation, so parallel operations
 * really run in parallel). Every transaction starts with
 * `SET LOCAL lock_timeout`, and lock/deadlock/serialization/connection errors
 * come out as TransientInfrastructureError.
 */
@Injectable()
export class TransactionRunner {
  constructor(
    private readonly em: EntityManager,
    @Inject(LOCK_TIMEOUT_MS) private readonly lockTimeoutMs: number,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Runs read-only queries on a forked EntityManager (no explicit
   * transaction). Connection problems come out as TransientInfrastructureError.
   */
  async read<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await work(this.em.fork());
    } catch (error) {
      throw toTransientIfNeeded(error);
    }
  }

  async run<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    const fork = this.em.fork();

    try {
      return await fork.transactional(async (tx) => {
        // SET LOCAL does not accept bind parameters; set_config(..., true)
        // is the transaction-local equivalent.
        await tx.execute(`select set_config('lock_timeout', ?, true)`, [
          `${this.lockTimeoutMs}ms`,
        ]);

        return work(tx);
      });
    } catch (error) {
      const mapped = toTransientIfNeeded(error);

      // lock_timeout (55P03) and deadlock (40P01) are the contention signals.
      if (
        mapped instanceof TransientInfrastructureError &&
        mapped.sqlState !== undefined &&
        LOCK_CONFLICT_STATES.has(mapped.sqlState)
      ) {
        this.metrics?.lockConflicts.inc();
      }

      throw mapped;
    }
  }
}
