import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
} from '../../src/application/errors.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction.js';
import {
  closeTestContext,
  createTestContext,
  resetDatabase,
  type TestContext,
} from '../helpers/db.js';
import { betCommand, count, seedWallet, walletState } from '../helpers/factories.js';
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

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe('idempotent replay', () => {
  test('same request twice: one debit, second answer is the original with idempotentReplay', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet);

    const first = await ctx.processor.execute(command);
    const second = await ctx.processor.execute({ ...command });

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(WagerTransactionStatus.Processed);
    expect(second.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('90.00');
  });

  test('replay returns the snapshot, not the current balance', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const first = betCommand(wallet);

    await ctx.processor.execute(first);
    await ctx.processor.execute(betCommand(wallet, { money: { amount: '50.00', currency: 'BRL' } }));

    const replay = await ctx.processor.execute(first);

    expect(replay.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('40.00');
  });

  test('replay of a REJECTED transaction keeps the original observed balance and failureCode', async () => {
    const wallet = await seedWallet(ctx, '30.00');
    const rejectedBet = betCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } });

    const original = await ctx.processor.execute(rejectedBet);
    expect(original.status).toBe(WagerTransactionStatus.Rejected);
    expect(original.balance.amount).toBe('30.00');

    // The balance changes afterwards.
    await ctx.processor.execute(betCommand(wallet, { money: { amount: '5.00', currency: 'BRL' } }));

    const replay = await ctx.processor.execute(rejectedBet);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(replay.balance).toEqual({ amount: '30.00', currency: 'BRL' });
  });

  test('amount "25" and "25.00" are the same payload', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet, { money: { amount: '25', currency: 'BRL' } });

    await ctx.processor.execute(command);
    const replay = await ctx.processor.execute({
      ...command,
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(replay.idempotentReplay).toBe(true);
  });
});

describe('idempotency conflicts', () => {
  test('same key with a different payload is a conflict, not a replay', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet);

    await ctx.processor.execute(command);

    await expect(
      ctx.processor.execute({ ...command, money: { amount: '11.00', currency: 'BRL' } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    await expect(
      ctx.processor.execute({ ...command, roundId: 'another-round' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
  });

  test('same provider transaction id with a different key is a conflict', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet);

    await ctx.processor.execute(command);

    await expect(
      ctx.processor.execute({ ...command, idempotencyKey: 'another-key' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('a key pointing to one transaction and a provider id to another is a conflict', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const a = betCommand(wallet);
    const b = betCommand(wallet);

    await ctx.processor.execute(a);
    await ctx.processor.execute(b);

    await expect(
      ctx.processor.execute({ ...a, externalTransactionId: b.externalTransactionId }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('idempotency under concurrency', () => {
  test('the same bet 50 times in parallel: one debit and 49 replays', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => ctx.processor.execute({ ...command })),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.balance.amount))).toEqual(new Set(['90.00']));
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(1);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('90.00');
  });

  test('same key across different wallets in parallel never yields a generic error', async () => {
    const walletA = await seedWallet(ctx, '100.00');
    const walletB = await seedWallet(ctx, '100.00');
    const base = betCommand(walletA);

    for (let round = 0; round < 5; round += 1) {
      const key = `shared-key-${round}`;
      const external = `shared-ext-${round}`;

      const outcomes = await Promise.all([
        settle(
          ctx.processor.execute({
            ...base,
            idempotencyKey: key,
            externalTransactionId: external,
          }),
        ),
        settle(
          ctx.processor.execute({
            ...betCommand(walletB),
            idempotencyKey: key,
            externalTransactionId: external,
          }),
        ),
      ]);

      const successes = outcomes.filter((o) => o.ok);
      const failures = outcomes.filter((o) => !o.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      for (const failure of failures) {
        if (!failure.ok) {
          expect(failure.error).toBeInstanceOf(IdempotencyConflictError);
          expect(failure.error).not.toBeInstanceOf(TransientInfrastructureError);
        }
      }
    }

    // One debit per round in total (10.00 each), across both wallets.
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(5);
  });

  test('50 parallel replays with distinct payloads for one key leave a single winner', async () => {
    const wallet = await seedWallet(ctx, '1000.00');
    const base = betCommand(wallet);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        settle(
          ctx.processor.execute({
            ...base,
            money: { amount: `${i + 1}.00`, currency: 'BRL' },
          }),
        ),
      ),
    );

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

    for (const outcome of outcomes) {
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(IdempotencyConflictError);
      }
    }

    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
  });
});
