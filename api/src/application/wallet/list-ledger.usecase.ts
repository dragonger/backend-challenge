import { Injectable } from '@nestjs/common';

import type { MoneyProps } from '../../domain/money/money.js';
import { TransactionRunner } from '../../infrastructure/database/transaction-runner.js';
import { WalletNotFoundError } from '../errors.js';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 200;

export interface LedgerItem {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItem[];
  /** `sequence` of the last item when there are more pages, otherwise undefined. */
  nextAfterSequence?: string;
}

interface LedgerRow {
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
  sequence_text: string;
}

/**
 * Keyset pagination over `wallet_ledger_entries.sequence` (identity column,
 * strictly increasing in insertion order). `sequence > :after ORDER BY
 * sequence LIMIT n+1` costs the same on every page (index
 * wallet_ledger_entries_wallet_sequence_idx) and, unlike OFFSET, new entries
 * (always appended with a higher sequence) never make a page repeat or skip
 * rows.
 */
@Injectable()
export class ListLedger {
  constructor(private readonly runner: TransactionRunner) {}

  execute(input: {
    walletId: string;
    afterSequence?: string;
    limit?: number;
  }): Promise<LedgerPage> {
    const limit = input.limit ?? DEFAULT_LEDGER_PAGE_SIZE;

    return this.runner.read(async (em) => {
      const wallet = await em.execute<Array<{ id: string }>>(
        `select id from wallets where id = ?`,
        [input.walletId],
      );

      if (!wallet[0]) {
        throw new WalletNotFoundError(input.walletId);
      }

      const rows = await em.execute<LedgerRow[]>(
        `select id, transaction_id, direction, amount::text as amount, currency,
                balance_before::text as balance_before,
                balance_after::text as balance_after,
                created_at, sequence::text as sequence_text
           from wallet_ledger_entries l
          where l.wallet_id = ? and l.sequence > ?::bigint
          order by l.sequence
          limit ?`,
        [input.walletId, input.afterSequence ?? '0', limit + 1],
      );

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];

      return {
        items: page.map((row) => ({
          id: row.id,
          transactionId: row.transaction_id,
          direction: row.direction,
          money: { amount: row.amount, currency: row.currency },
          balanceBefore: { amount: row.balance_before, currency: row.currency },
          balanceAfter: { amount: row.balance_after, currency: row.currency },
          createdAt: new Date(row.created_at).toISOString(),
        })),
        ...(rows.length > limit && last ? { nextAfterSequence: last.sequence_text } : {}),
      };
    });
  }
}
