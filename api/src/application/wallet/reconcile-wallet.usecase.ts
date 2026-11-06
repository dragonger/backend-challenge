import { Injectable, Logger } from '@nestjs/common';

import type { MoneyProps } from '../../domain/money/money.js';
import { MetricsService } from '../../infrastructure/metrics/metrics.service.js';
import { TransactionRunner } from '../../infrastructure/database/transaction-runner.js';
import { WalletNotFoundError } from '../errors.js';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** stored - calculated (may be negative). */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

interface ReconciliationRow {
  currency: string;
  stored: string;
  calculated: string;
  difference: string;
  consistent: boolean;
  entries: string;
}

/**
 * Compares wallets.balance with the balance rebuilt from the ledger
 * (credits - debits). Everything is computed in ONE SQL statement, inside a
 * transaction: a single statement reads one snapshot, and the financial path
 * commits wallet and ledger together, so the comparison never sees half of a
 * movement. Decimal math stays in PostgreSQL (numeric), no float involved.
 *
 * It NEVER fixes anything: a divergence is logged, counted and reported so a
 * person can investigate (auto-fixing would hide the bug that caused it).
 */
@Injectable()
export class ReconcileWallet {
  private readonly logger = new Logger(ReconcileWallet.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: MetricsService,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const row = await this.runner.run(async (em) => {
      const rows = await em.execute<ReconciliationRow[]>(
        `select w.currency,
                w.balance::text as stored,
                coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated,
                (w.balance - coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0))::numeric(20,2)::text as difference,
                (w.balance = coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)) as consistent,
                count(l.id)::text as entries
           from wallets w
           left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      );

      return rows[0];
    });

    if (!row) {
      throw new WalletNotFoundError(walletId);
    }

    const money = (amount: string): MoneyProps => ({
      amount,
      currency: row.currency,
    });
    const { consistent } = row;
    const checkedEntries = Number(row.entries);

    if (!consistent) {
      this.metrics.reconciliationMismatches.inc();
      this.logger.warn({
        message: 'Wallet reconciliation mismatch',
        walletId,
        difference: row.difference,
        currency: row.currency,
        checkedEntries,
      });
    }

    return {
      walletId,
      storedBalance: money(row.stored),
      calculatedBalance: money(row.calculated),
      difference: money(row.difference),
      consistent,
      checkedEntries,
    };
  }
}
