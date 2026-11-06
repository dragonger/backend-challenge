import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { WalletNotFoundError } from '../../src/application/errors.js';
import {
  closeTestContext,
  createTestContext,
  resetDatabase,
  type TestContext,
} from '../helpers/db.js';
import { operation, seedWallet, walletState } from '../helpers/factories.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';

let ctx: TestContext;

beforeAll(async () => {
  // The warn log of a detected mismatch is expected here; keep the output clean.
  Logger.overrideLogger(false);
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

const mismatches = async () => (await ctx.metrics.registry.getMetricsAsJSON())
  .find((m) => m.name === 'wallet_reconciliation_mismatches_total')
  ?.values[0]?.value ?? 0;

describe('ReconcileWallet', () => {
  test('a consistent wallet reports zero difference and counts the entries', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    await ctx.processor.execute(operation(wallet, 'BET', '25.00'));
    await ctx.processor.execute(operation(wallet, 'WIN', '10.50'));
    await ctx.processor.execute(operation(wallet, 'LOSS', '0.00'));

    const result = await ctx.reconciler.execute(wallet.walletId);

    expect(result).toEqual({
      walletId: wallet.walletId,
      storedBalance: { amount: '85.50', currency: 'BRL' },
      calculatedBalance: { amount: '85.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
    expect(await mismatches()).toBe(0);
  });

  test('a wallet without ledger is consistent at zero', async () => {
    const wallet = await seedWallet(ctx, '0.00');

    const result = await ctx.reconciler.execute(wallet.walletId);

    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
    expect(result.calculatedBalance.amount).toBe('0.00');
  });

  test('a divergence created by a direct UPDATE is reported, counted and NEVER fixed', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    await ctx.processor.execute(operation(wallet, 'BET', '25.00'));
    await ctx.em.execute(`update wallets set balance = balance + 7.25 where id = ?`, [
      wallet.walletId,
    ]);

    const result = await ctx.reconciler.execute(wallet.walletId);

    expect(result.consistent).toBe(false);
    expect(result.storedBalance.amount).toBe('82.25');
    expect(result.calculatedBalance.amount).toBe('75.00');
    expect(result.difference.amount).toBe('7.25');
    expect(result.checkedEntries).toBe(2);
    expect(await mismatches()).toBe(1);
    // Nothing was corrected.
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('82.25');

    // Negative difference too.
    await ctx.em.execute(`update wallets set balance = 70.00 where id = ?`, [wallet.walletId]);
    const lower = await ctx.reconciler.execute(wallet.walletId);
    expect(lower.difference.amount).toBe('-5.00');
    expect(await mismatches()).toBe(2);

    // Restore so the global invariant holds for this test.
    await ctx.em.execute(`update wallets set balance = 75.00 where id = ?`, [wallet.walletId]);
  });

  test('unknown wallet', async () => {
    await expect(ctx.reconciler.execute(randomUUID())).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});
