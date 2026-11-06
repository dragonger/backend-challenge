import { describe, expect, test } from 'bun:test';
import type { ProcessWagerTransactionResult } from '../../../application/wagering/commands.js';
import { WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.js';
import { statusForResult } from './result-status.js';

const result = (
  status: WagerTransactionStatus,
  idempotentReplay: boolean,
): ProcessWagerTransactionResult => ({
  transactionId: 't',
  status,
  balance: { amount: '1.00', currency: 'BRL' },
  idempotentReplay,
});

describe('statusForResult', () => {
  test.each([
    [WagerTransactionStatus.Processed, false, 201],
    [WagerTransactionStatus.Processed, true, 200],
    [WagerTransactionStatus.Rejected, false, 422],
    [WagerTransactionStatus.Rejected, true, 422],
    [WagerTransactionStatus.PendingReference, false, 202],
    [WagerTransactionStatus.PendingReference, true, 202],
    [WagerTransactionStatus.Failed, false, 500],
  ] as const)('%s replay=%p -> %p', (status, replay, expected) => {
    expect(statusForResult(result(status, replay))).toBe(expected);
  });
});
