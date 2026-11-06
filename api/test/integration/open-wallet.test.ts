import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { WalletAlreadyExistsError } from '../../src/application/errors.js';
import {
  closeTestContext,
  createTestContext,
  resetDatabase,
  type TestContext,
} from '../helpers/db.js';
import { count, walletState } from '../helpers/factories.js';
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

describe('OpenWallet', () => {
  test('creates wallet, OPENING transaction, CREDIT ledger entry and events atomically', async () => {
    const playerId = randomUUID();

    const wallet = await ctx.openWallet.execute({
      playerId,
      initialBalance: { amount: '1000', currency: 'BRL' },
    });

    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(await walletState(ctx, wallet.id)).toEqual({ balance: '1000.00', version: 1 });

    const [tx] = await ctx.em.execute<
      Array<{ kind: string; status: string; balance_after: string; provider_id: string }>
    >(`select kind, status, balance_after::text, provider_id from wager_transactions`);
    expect(tx).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', balance_after: '1000.00' });

    const [entry] = await ctx.em.execute<
      Array<{ direction: string; balance_before: string; balance_after: string }>
    >(`select direction, balance_before::text, balance_after::text from wallet_ledger_entries`);
    expect(entry).toEqual({
      direction: 'CREDIT',
      balance_before: '0.00',
      balance_after: '1000.00',
    });

    const events = await ctx.em.execute<Array<{ event_type: string }>>(
      `select event_type from outbox_messages order by sequence`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('zero initial balance creates only the wallet', async () => {
    await ctx.openWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(await count(ctx, 'wallets')).toBe(1);
    expect(await count(ctx, 'wager_transactions')).toBe(0);
    expect(await count(ctx, 'wallet_ledger_entries')).toBe(0);
    expect(await count(ctx, 'outbox_messages')).toBe(0);
  });

  test('duplicate playerId + currency is a conflict; another currency is fine', async () => {
    const playerId = randomUUID();
    await ctx.openWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    await expect(
      ctx.openWallet.execute({
        playerId,
        initialBalance: { amount: '99.00', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    await ctx.openWallet.execute({
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });

    expect(await count(ctx, 'wallets')).toBe(2);
  });

  test('concurrent creation for the same player yields exactly one wallet', async () => {
    const playerId = randomUUID();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        ctx.openWallet.execute({
          playerId,
          initialBalance: { amount: '10.00', currency: 'BRL' },
        }),
      ),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(WalletAlreadyExistsError);
      }
    }

    expect(await count(ctx, 'wallets')).toBe(1);
    expect(await count(ctx, 'wallet_ledger_entries')).toBe(1);
    expect(await count(ctx, 'outbox_messages')).toBe(2);
  });
});
