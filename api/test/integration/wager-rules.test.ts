import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction.js';
import { ResolvePendingOutcome } from '../../src/application/wagering/resolve-pending-transaction.usecase.js';
import {
  closeTestContext,
  createTestContext,
  resetDatabase,
  type TestContext,
} from '../helpers/db.js';
import {
  count,
  eventTypesOf,
  nextId,
  operation,
  seedWallet,
  txRow,
  walletState,
  type SeededWallet,
} from '../helpers/factories.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

beforeEach(async () => {
  await resetDatabase(ctx.em);
});

afterEach(async () => {
  await assertLedgerInvariant(ctx.em);
});

afterAll(async () => {
  await closeTestContext(ctx);
});

const ledgerCount = (walletId: string) =>
  count(ctx, 'wallet_ledger_entries', `wallet_id = '${walletId}'`);

/** Processes a BET / WIN and returns its command and result. */
async function submit(
  wallet: SeededWallet,
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
  amount: string,
  reference?: string,
  overrides = {},
) {
  const command = operation(wallet, kind, amount, reference, overrides);
  const result = await ctx.processor.execute(command);

  return { command, result, ext: command.externalTransactionId };
}

describe('WIN', () => {
  test('without reference credits the wallet', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    const { result } = await submit(wallet, 'WIN', '40.00');

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '140.00', currency: 'BRL' });
    expect(await ledgerCount(wallet.walletId)).toBe(2);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '140.00', version: 2 });
  });

  test('referencing the BET of the round links it and emits Processed + BalanceChanged', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '25.00');
    await ctx.em.execute(`truncate table outbox_messages`);

    const win = await submit(wallet, 'WIN', '60.00', bet.ext);

    expect(win.result.balance).toEqual({ amount: '135.00', currency: 'BRL' });
    expect((await txRow(ctx, win.result.transactionId)).reference_transaction_id).toBe(
      bet.result.transactionId,
    );
    expect(await eventTypesOf(ctx)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('referencing a REJECTED BET is REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await seedWallet(ctx, '10.00');
    const bet = await submit(wallet, 'BET', '50.00');
    expect(bet.result.failureCode).toBe(FailureCode.InsufficientBalance);

    const win = await submit(wallet, 'WIN', '5.00', bet.ext);

    expect(win.result.status).toBe(WagerTransactionStatus.Rejected);
    expect(win.result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '10.00', version: 1 });
  });

  test('referencing a transaction of another round is REFERENCE_MISMATCH', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '10.00', undefined, { roundId: 'round-A' });

    const win = await submit(wallet, 'WIN', '5.00', bet.ext, { roundId: 'round-B' });

    expect(win.result.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('referencing something that is not a BET is INVALID_REFERENCE_KIND', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const first = await submit(wallet, 'WIN', '5.00');

    const second = await submit(wallet, 'WIN', '5.00', first.ext);

    expect(second.result.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });
});

describe('LOSS', () => {
  test('is PROCESSED without moving the balance, without ledger and without BalanceChanged', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');
    await ctx.em.execute(`truncate table outbox_messages`);

    const loss = await submit(wallet, 'LOSS', '0.00', bet.ext);

    expect(loss.result.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.result.balance).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '70.00', version: 2 });
    expect(await ledgerCount(wallet.walletId)).toBe(2);
    expect(
      await count(ctx, 'wallet_ledger_entries', `transaction_id = '${loss.result.transactionId}'`),
    ).toBe(0);
    expect(await eventTypesOf(ctx)).toEqual(['WagerTransactionProcessed']);
  });

  test('without reference is accepted too', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    const loss = await submit(wallet, 'LOSS', '0.00');

    expect(loss.result.status).toBe(WagerTransactionStatus.Processed);
  });

  test('LOSS whose BET is missing waits for it', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    const loss = await submit(wallet, 'LOSS', '0.00', 'bet-not-here-yet');

    expect(loss.result.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe('REFUND', () => {
  test('credits back the BET amount, links the reference and cannot be repeated', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');

    const refund = await submit(wallet, 'REFUND', '30.00', bet.ext);

    expect(refund.result.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect((await txRow(ctx, refund.result.transactionId)).reference_transaction_id).toBe(
      bet.result.transactionId,
    );

    const again = await submit(wallet, 'REFUND', '30.00', bet.ext);

    expect(again.result.status).toBe(WagerTransactionStatus.Rejected);
    expect(again.result.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(again.result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  test('amount different from the BET is AMOUNT_MISMATCH', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');

    const refund = await submit(wallet, 'REFUND', '10.00', bet.ext);

    expect(refund.result.failureCode).toBe(FailureCode.AmountMismatch);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '70.00', version: 2 });
  });

  test('refund of a WIN is INVALID_REFERENCE_KIND', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const win = await submit(wallet, 'WIN', '30.00');

    const refund = await submit(wallet, 'REFUND', '30.00', win.ext);

    expect(refund.result.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('refund of a REJECTED BET is REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await seedWallet(ctx, '10.00');
    const bet = await submit(wallet, 'BET', '50.00');

    const refund = await submit(wallet, 'REFUND', '50.00', bet.ext);

    expect(refund.result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('reference of another round is REFERENCE_MISMATCH', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00', undefined, { roundId: 'round-A' });

    const refund = await submit(wallet, 'REFUND', '30.00', bet.ext, { roundId: 'round-B' });

    expect(refund.result.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('reference that belongs to another wallet is REFERENCE_MISMATCH', async () => {
    const walletA = await seedWallet(ctx, '100.00');
    const walletB = await seedWallet(ctx, '100.00');
    const betOnA = await submit(walletA, 'BET', '30.00');

    const refundOnB = await submit(walletB, 'REFUND', '30.00', betOnA.ext);

    expect(refundOnB.result.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(await walletState(ctx, walletB.walletId)).toEqual({ balance: '100.00', version: 1 });
    expect(await walletState(ctx, walletA.walletId)).toEqual({ balance: '70.00', version: 2 });
  });

  test('reference of another provider is not found (providerId is part of the lookup)', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');

    const refund = await submit(wallet, 'REFUND', '30.00', bet.ext, {
      providerId: 'provider-b',
    });

    expect(refund.result.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('rejections never create ledger entries', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');

    await submit(wallet, 'REFUND', '1.00', bet.ext);
    await submit(wallet, 'REFUND', '30.00', bet.ext, { roundId: 'x' });

    expect(await ledgerCount(wallet.walletId)).toBe(2);
    expect(await count(ctx, 'wager_transactions', `status = 'REJECTED'`)).toBe(2);
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');

    const rollback = await submit(wallet, 'ROLLBACK', '30.00', bet.ext);

    expect(rollback.result.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const [entry] = await ctx.em.execute<Array<{ direction: string }>>(
      `select direction from wallet_ledger_entries where transaction_id = ?`,
      [rollback.result.transactionId],
    );
    expect(entry?.direction).toBe('CREDIT');
  });

  test('of a WIN debits', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const win = await submit(wallet, 'WIN', '40.00');

    const rollback = await submit(wallet, 'ROLLBACK', '40.00', win.ext);

    expect(rollback.result.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const [entry] = await ctx.em.execute<Array<{ direction: string }>>(
      `select direction from wallet_ledger_entries where transaction_id = ?`,
      [rollback.result.transactionId],
    );
    expect(entry?.direction).toBe('DEBIT');
  });

  test('of a REFUND debits', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');
    const refund = await submit(wallet, 'REFUND', '30.00', bet.ext);

    const rollback = await submit(wallet, 'ROLLBACK', '30.00', refund.ext);

    expect(rollback.result.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.result.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  });

  test('of a WIN that would overdraw is REVERSAL_WOULD_OVERDRAW: persisted, auditable, no ledger', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const win = await submit(wallet, 'WIN', '50.00');
    await submit(wallet, 'BET', '140.00');
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('10.00');
    await ctx.em.execute(`truncate table outbox_messages`);

    const rollback = await submit(wallet, 'ROLLBACK', '50.00', win.ext);

    expect(rollback.result.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.result.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(rollback.result.failureCode).not.toBe(FailureCode.InsufficientBalance);
    expect(rollback.result.balance).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(
      await count(ctx, 'wallet_ledger_entries', `transaction_id = '${rollback.result.transactionId}'`),
    ).toBe(0);
    expect((await txRow(ctx, rollback.result.transactionId)).status).toBe('REJECTED');
    expect(await eventTypesOf(ctx)).toEqual(['WagerTransactionRejected']);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '10.00', version: 3 });

    // The rejected attempt did not consume the reversal: after the player
    // gets money back, the same WIN can still be rolled back by a new request.
    await submit(wallet, 'WIN', '100.00');
    const retry = await submit(wallet, 'ROLLBACK', '50.00', win.ext);
    expect(retry.result.status).toBe(WagerTransactionStatus.Processed);
  });

  test.each(['ROLLBACK', 'LOSS'] as const)('of a %s is INVALID_REFERENCE_KIND', async (kind) => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');
    const target =
      kind === 'ROLLBACK'
        ? await submit(wallet, 'ROLLBACK', '30.00', bet.ext)
        : await submit(wallet, 'LOSS', '0.00', bet.ext);

    const rollback = await submit(wallet, 'ROLLBACK', '30.00', target.ext);

    expect(rollback.result.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('of the OPENING credit is forbidden', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    const rollback = await submit(wallet, 'ROLLBACK', '100.00', `opening:${wallet.walletId}`, {
      providerId: 'internal',
      roundId: 'opening',
      gameId: 'opening',
    });

    expect(rollback.result.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('100.00');
  });

  test('a transaction is reversed ONCE in total: REFUND then ROLLBACK of the same BET', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');
    await submit(wallet, 'REFUND', '30.00', bet.ext);

    const rollback = await submit(wallet, 'ROLLBACK', '30.00', bet.ext);

    expect(rollback.result.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('100.00');
  });

  test('amount different from the reference is AMOUNT_MISMATCH', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const win = await submit(wallet, 'WIN', '40.00');

    const rollback = await submit(wallet, 'ROLLBACK', '39.99', win.ext);

    expect(rollback.result.failureCode).toBe(FailureCode.AmountMismatch);
  });
});

describe('reference arrives later (PENDING_REFERENCE)', () => {
  test('ROLLBACK before its BET: 0 attempts, scheduled, event, no balance effect, replay with current balance', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    await ctx.em.execute(`truncate table outbox_messages`);
    const before = Date.now();

    const rollback = await submit(wallet, 'ROLLBACK', '30.00', 'bet-arrives-later');

    expect(rollback.result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rollback.result.idempotentReplay).toBe(false);
    expect(rollback.result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const row = await txRow(ctx, rollback.result.transactionId);
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).not.toBeNull();
    expect(row.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(before + 700);
    expect(row.next_attempt_at!.getTime()).toBeLessThanOrEqual(before + 5000);
    expect(await eventTypesOf(ctx)).toEqual(['WagerTransactionPendingReference']);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '100.00', version: 1 });

    // Another transaction moves the balance; the replay reports the CURRENT one.
    await submit(wallet, 'BET', '10.00');
    const replay = await ctx.processor.execute(rollback.command);

    expect(replay.status).toBe(WagerTransactionStatus.PendingReference);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(rollback.result.transactionId);
    expect(replay.balance).toEqual({ amount: '90.00', currency: 'BRL' });
  });

  test('REFUND before its BET is resolved once the BET arrives', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const betCommand = operation(wallet, 'BET', '30.00');
    const refund = await submit(wallet, 'REFUND', '30.00', betCommand.externalTransactionId);
    expect(refund.result.status).toBe(WagerTransactionStatus.PendingReference);

    const stillMissing = await ctx.resolver.execute(refund.result.transactionId);
    expect(stillMissing.outcome).toBe(ResolvePendingOutcome.Rescheduled);
    expect(stillMissing.attempts).toBe(1);

    const bet = await ctx.processor.execute(betCommand);
    expect(bet.balance.amount).toBe('70.00');

    await ctx.em.execute(`truncate table outbox_messages`);
    const resolved = await ctx.resolver.execute(refund.result.transactionId);

    expect(resolved.outcome).toBe(ResolvePendingOutcome.Processed);
    expect(resolved.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const row = await txRow(ctx, refund.result.transactionId);
    expect(row.status).toBe('PROCESSED');
    expect(row.reference_transaction_id).toBe(bet.transactionId);
    expect(row.next_attempt_at).toBeNull();
    expect(await eventTypesOf(ctx)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '100.00', version: 3 });

    // The original request now replays the final result.
    const replay = await ctx.processor.execute(refund.command);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('ROLLBACK of a WIN that arrives later debits when resolved', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const winCommand = operation(wallet, 'WIN', '25.00');
    const rollback = await submit(wallet, 'ROLLBACK', '25.00', winCommand.externalTransactionId);
    await ctx.processor.execute(winCommand);

    const resolved = await ctx.resolver.execute(rollback.result.transactionId);

    expect(resolved.status).toBe(WagerTransactionStatus.Processed);
    expect(resolved.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('a late reference that is invalid rejects the pending transaction', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const winCommand = operation(wallet, 'WIN', '25.00');
    const refund = await submit(wallet, 'REFUND', '25.00', winCommand.externalTransactionId);
    await ctx.processor.execute(winCommand);
    await ctx.em.execute(`truncate table outbox_messages`);

    const resolved = await ctx.resolver.execute(refund.result.transactionId);

    expect(resolved.outcome).toBe(ResolvePendingOutcome.Rejected);
    expect(resolved.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(await eventTypesOf(ctx)).toEqual(['WagerTransactionRejected']);
  });

  test('a late reversal that would overdraw is rejected REVERSAL_WOULD_OVERDRAW', async () => {
    const wallet = await seedWallet(ctx, '10.00');
    const winCommand = operation(wallet, 'WIN', '50.00');
    const rollback = await submit(wallet, 'ROLLBACK', '50.00', winCommand.externalTransactionId);
    await ctx.processor.execute(winCommand);
    await submit(wallet, 'BET', '55.00');

    const resolved = await ctx.resolver.execute(rollback.result.transactionId);

    expect(resolved.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '5.00', version: 3 });
  });

  test('exhausting the attempt limit rejects with REFERENCE_NOT_FOUND and emits Rejected', async () => {
    const tight = await createTestContext({
      pendingReference: { maxAttempts: 2, initialBackoffMs: 10, jitterRatio: 0 },
    });

    try {
      const wallet = await seedWallet(tight, '100.00');
      const refund = operation(wallet, 'REFUND', '30.00', 'never-arrives');
      const first = await tight.processor.execute(refund);
      expect(first.status).toBe(WagerTransactionStatus.PendingReference);
      await tight.em.execute(`truncate table outbox_messages`);

      const attempt1 = await tight.resolver.execute(first.transactionId);
      expect(attempt1.outcome).toBe(ResolvePendingOutcome.Rescheduled);
      expect(attempt1.attempts).toBe(1);
      expect(await eventTypesOf(tight)).toEqual([]);

      const attempt2 = await tight.resolver.execute(first.transactionId);
      expect(attempt2.outcome).toBe(ResolvePendingOutcome.Rejected);
      expect(attempt2.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(await eventTypesOf(tight)).toEqual(['WagerTransactionRejected']);
      expect((await walletState(tight, wallet.walletId)).balance).toBe('100.00');
      expect(await ledgerCountOf(tight, wallet.walletId)).toBe(1);

      const replay = await tight.processor.execute(refund);
      expect(replay.status).toBe(WagerTransactionStatus.Rejected);
      expect(replay.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(replay.idempotentReplay).toBe(true);

      await assertLedgerInvariant(tight.em);
    } finally {
      await closeTestContext(tight);
    }
  });

  test('exceeding the TTL rejects even with attempts left', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const refund = await submit(wallet, 'REFUND', '30.00', 'never-arrives');

    const later = new Date(Date.now() + 16 * 60 * 1000);
    const resolved = await ctx.resolver.execute(refund.result.transactionId, { now: later });

    expect(resolved.outcome).toBe(ResolvePendingOutcome.Rejected);
    expect(resolved.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('NOT_FOUND and NOT_PENDING outcomes do nothing', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '10.00');

    const missing = await ctx.resolver.execute('00000000-0000-4000-8000-000000000000');
    const processed = await ctx.resolver.execute(bet.result.transactionId);

    expect(missing.outcome).toBe(ResolvePendingOutcome.NotFound);
    expect(processed.outcome).toBe(ResolvePendingOutcome.NotPending);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('90.00');
  });

  test('findDueIds returns only due pending rows, skipping resolved ones', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const a = await submit(wallet, 'REFUND', '10.00', 'late-a');
    const b = await submit(wallet, 'REFUND', '10.00', 'late-b');

    expect(await ctx.pending.findDueIds(10, new Date())).toEqual([]);

    const later = new Date(Date.now() + 5 * 60 * 1000);
    const due = await ctx.pending.findDueIds(10, later);
    expect(new Set(due)).toEqual(new Set([a.result.transactionId, b.result.transactionId]));
    expect(await ctx.pending.findDueIds(1, later)).toHaveLength(1);

    await ctx.resolver.execute(a.result.transactionId, { now: new Date(Date.now() + 99 * 60 * 1000) });
    expect(await ctx.pending.findDueIds(10, later)).toEqual([b.result.transactionId]);
  });

  test('concurrent workers resolving the same pending row: one applies, the others find it resolved', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const betCommand = operation(wallet, 'BET', '30.00');
    const refund = await submit(wallet, 'REFUND', '30.00', betCommand.externalTransactionId);
    await ctx.processor.execute(betCommand);

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => ctx.resolver.execute(refund.result.transactionId)),
    );

    expect(outcomes.filter((o) => o.outcome === ResolvePendingOutcome.Processed)).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === ResolvePendingOutcome.NotPending)).toHaveLength(9);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });
});

describe('a transaction is reversed only once, even under concurrency', () => {
  test('REFUND and ROLLBACK racing for the same BET: one PROCESSED, one REJECTED', async () => {
    for (let round = 0; round < 8; round += 1) {
      const wallet = await seedWallet(ctx, '100.00');
      const bet = await submit(wallet, 'BET', '30.00');

      const results = await Promise.all([
        ctx.processor.execute(operation(wallet, 'REFUND', '30.00', bet.ext)),
        ctx.processor.execute(operation(wallet, 'ROLLBACK', '30.00', bet.ext)),
      ]);

      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
      const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);

      expect(processed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect((await walletState(ctx, wallet.walletId)).balance).toBe('100.00');
    }
  });

  test('twenty parallel REFUNDs (distinct ids) of one BET credit exactly once', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await submit(wallet, 'BET', '30.00');

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.processor.execute(operation(wallet, 'REFUND', '30.00', bet.ext)),
      ),
    );

    expect(results.filter((r) => r.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((r) => r.status === WagerTransactionStatus.Rejected)).toHaveLength(19);
    expect(await walletState(ctx, wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
    expect(
      await count(ctx, 'wager_transactions', `kind = 'REFUND' and status = 'PROCESSED'`),
    ).toBe(1);
  });

  test('a BET arriving while its REFUND is processed never double-applies', async () => {
    for (let round = 0; round < 5; round += 1) {
      const wallet = await seedWallet(ctx, '100.00');
      const betCommand = operation(wallet, 'BET', '30.00', undefined, {
        externalTransactionId: nextId('late-bet'),
      });
      const refundCommand = operation(wallet, 'REFUND', '30.00', betCommand.externalTransactionId);

      const [bet, refund] = await Promise.all([
        ctx.processor.execute(betCommand),
        ctx.processor.execute(refundCommand),
      ]);

      expect(bet.status).toBe(WagerTransactionStatus.Processed);

      if (refund.status === WagerTransactionStatus.PendingReference) {
        const resolved = await ctx.resolver.execute(refund.transactionId);
        expect(resolved.outcome).toBe(ResolvePendingOutcome.Processed);
      } else {
        expect(refund.status).toBe(WagerTransactionStatus.Processed);
      }

      expect((await walletState(ctx, wallet.walletId)).balance).toBe('100.00');
    }
  });
});

async function ledgerCountOf(target: TestContext, walletId: string): Promise<number> {
  return count(target, 'wallet_ledger_entries', `wallet_id = '${walletId}'`);
}
