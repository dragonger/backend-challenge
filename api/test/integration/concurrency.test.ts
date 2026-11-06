import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.usecase.js';
import { TransactionRunner } from '../../src/infrastructure/database/transaction-runner.js';
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

describe('concurrency on the same wallet', () => {
  test('required scenario: 100.00 and two simultaneous bets of 80.00', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    const results = await Promise.all(
      [1, 2].map(() =>
        ctx.processor.execute(
          betCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
        ),
      ),
    );

    const processed = results.filter((r) => r.status === 'PROCESSED');
    const rejected = results.filter((r) => r.status === 'REJECTED');

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.failureCode)).toBe('INSUFFICIENT_BALANCE');
    expect(rejected[0]?.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(processed[0]?.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    expect((await walletState(ctx, wallet.walletId)).balance).toBe('20.00');
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
    // OPENING credit + the single debit
    expect(await count(ctx, 'wallet_ledger_entries')).toBe(2);
  });

  test('30 bets of 10.00 on a 100.00 wallet: exactly 10 processed, never negative', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () => ctx.processor.execute(betCommand(wallet))),
    );

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(20);

    const state = await walletState(ctx, wallet.walletId);
    expect(state.balance).toBe('0.00');
    expect(state.version).toBe(11);
  });
});

describe('concurrency across wallets', () => {
  test('distinct wallets are processed in parallel and independently', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 12 }, () => seedWallet(ctx, '50.00')),
    );

    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        [1, 2, 3].map(() =>
          ctx.processor.execute(
            betCommand(wallet, { money: { amount: '20.00', currency: 'BRL' } }),
          ),
        ),
      ),
    );

    // Each wallet: 50 -> 2 bets of 20 fit, the third is rejected.
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(24);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(12);

    for (const wallet of wallets) {
      expect((await walletState(ctx, wallet.walletId)).balance).toBe('10.00');
    }
  });

  test('lock is per wallet: a held lock on one wallet does not block another', async () => {
    const locked = await seedWallet(ctx, '100.00');
    const free = await seedWallet(ctx, '100.00');

    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const holder = ctx.runner.run(async (em) => {
      await em.execute(`select id from wallets where id = ? for update`, [
        locked.walletId,
      ]);
      acquired();
      await holding;
    });

    await lockAcquired;

    const started = Date.now();
    const result = await ctx.processor.execute(betCommand(free));
    expect(String(result.status)).toBe('PROCESSED');
    expect(Date.now() - started).toBeLessThan(2000);

    release();
    await holder;
  });
});

describe('lock timeout', () => {
  test('a lock that cannot be acquired becomes a TransientInfrastructureError', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const impatient = new ProcessWagerTransaction(
      new TransactionRunner(ctx.orm.em, 300),
    );

    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const holder = ctx.runner.run(async (em) => {
      await em.execute(`select id from wallets where id = ? for update`, [
        wallet.walletId,
      ]);
      acquired();
      await holding;
    });

    await lockAcquired;

    const error = await impatient
      .execute(betCommand(wallet))
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect((error as TransientInfrastructureError).sqlState).toBe('55P03');

    release();
    await holder;

    // Nothing was written by the timed out attempt.
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(0);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('100.00');
  });
});
