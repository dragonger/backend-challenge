import { Injectable } from '@nestjs/common';

import { TransactionRunner } from './transaction-runner.js';

/** Queries over transactions waiting for their reference. */
@Injectable()
export class PendingTransactionsRepository {
  constructor(private readonly runner: TransactionRunner) {}

  /**
   * Ids of PENDING_REFERENCE transactions whose retry is due, oldest due first.
   *
   * `FOR UPDATE SKIP LOCKED` makes concurrent workers pick disjoint rows and
   * skip the ones another instance is resolving right now (ResolvePending
   * Transaction holds the wallet lock and rewrites the row). The row locks last
   * only for this short query: the real mutual exclusion while resolving is the
   * wallet lock, and a loser simply finds the row already resolved. Uses the
   * partial index on next_attempt_at.
   */
  findDueIds(limit: number, now: Date = new Date()): Promise<string[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('limit must be a positive integer');
    }

    return this.runner.run(async (em) => {
      const rows = await em.execute<Array<{ id: string }>>(
        `select id from wager_transactions
          where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
          order by next_attempt_at
          limit ?
            for update skip locked`,
        [now, limit],
      );

      return rows.map((row) => row.id);
    });
  }
}
