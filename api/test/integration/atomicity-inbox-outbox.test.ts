import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../src/application/errors.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.usecase.js';
import { InvalidWagerTransactionError } from '../../src/domain/errors/domain-error.js';
import {
  closeTestContext,
  createTestContext,
  resetDatabase,
  type TestContext,
} from '../helpers/db.js';
import { betCommand, count, nextId, seedWallet, walletState } from '../helpers/factories.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';

/** Injects a failure after every row was written, right before the commit. */
class FailingBeforeCommit extends ProcessWagerTransaction {
  protected override beforeCommit(_em: EntityManager): Promise<void> {
    return Promise.reject(new Error('injected failure before commit'));
  }
}

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

const eventTypes = async (): Promise<string[]> => {
  const rows = await ctx.em.execute<Array<{ event_type: string }>>(
    `select event_type from outbox_messages order by sequence`,
  );
  return rows.map((r) => r.event_type);
};

describe('atomicity', () => {
  test('failure after the ledger and before the commit leaves nothing behind', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const baseline = {
      transactions: await count(ctx, 'wager_transactions'),
      ledger: await count(ctx, 'wallet_ledger_entries'),
      outbox: await count(ctx, 'outbox_messages'),
    };
    const failing = new FailingBeforeCommit(ctx.runner);

    await expect(
      failing.execute(
        betCommand(wallet, {
          inbox: { consumerName: 'sqs', messageId: 'msg-boom', payloadHash: 'h' },
        }),
      ),
    ).rejects.toThrow('injected failure before commit');

    expect(await count(ctx, 'wager_transactions')).toBe(baseline.transactions);
    expect(await count(ctx, 'wallet_ledger_entries')).toBe(baseline.ledger);
    expect(await count(ctx, 'outbox_messages')).toBe(baseline.outbox);
    expect(await count(ctx, 'inbox_messages')).toBe(0);
    expect(await walletState(ctx, wallet.walletId)).toEqual({
      balance: '100.00',
      version: 1,
    });
  });

  test('after a failed attempt the same command still succeeds exactly once', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet);

    await expect(new FailingBeforeCommit(ctx.runner).execute(command)).rejects.toThrow();
    const result = await ctx.processor.execute(command);

    expect(result.idempotentReplay).toBe(false);
    expect(String(result.status)).toBe('PROCESSED');
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
  });

  test('an error after the inbox insert (unknown wallet) rolls the inbox row back', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    await expect(
      ctx.processor.execute(
        betCommand(
          { ...wallet, walletId: '00000000-0000-4000-8000-000000000000' },
          {
            kind: 'WIN',
            inbox: { consumerName: 'sqs', messageId: 'msg-win', payloadHash: 'h' },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(WalletNotFoundError);

    expect(await count(ctx, 'wager_transactions', `kind = 'WIN'`)).toBe(0);
    expect(await count(ctx, 'inbox_messages')).toBe(0);
  });
});

describe('outbox', () => {
  test('a processed bet writes Processed and BalanceChanged in the same transaction', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    await ctx.em.execute(`truncate table outbox_messages`);

    const result = await ctx.processor.execute(betCommand(wallet));

    expect(await eventTypes()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    const rows = await ctx.em.execute<
      Array<{ id: string; aggregate_id: string; payload: Record<string, any>; published_at: string | null }>
    >(`select id, aggregate_id, payload, published_at from outbox_messages order by sequence`);

    for (const row of rows) {
      expect(row.published_at).toBeNull();
      expect(row.aggregate_id).toBe(wallet.walletId);
      expect(row.payload.eventId).toBe(row.id);
      expect(row.payload.version).toBe(1);
      expect(typeof row.payload.occurredAt).toBe('string');
      expect(row.payload.correlationId).toBeTruthy();
    }

    const changed = rows[1]?.payload;
    expect(changed?.data.direction).toBe('DEBIT');
    expect(changed?.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(changed?.data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(changed?.data.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(changed?.data.walletVersion).toBe(2);
    expect(changed?.data.transactionId).toBe(result.transactionId);
  });

  test('a rejected bet writes only Rejected, with no balance event', async () => {
    const wallet = await seedWallet(ctx, '5.00');
    await ctx.em.execute(`truncate table outbox_messages`);

    await ctx.processor.execute(betCommand(wallet));

    expect(await eventTypes()).toEqual(['WagerTransactionRejected']);
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(0);
  });

  test('a replay writes no new events', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet);
    await ctx.processor.execute(command);
    const before = await count(ctx, 'outbox_messages');

    await ctx.processor.execute(command);

    expect(await count(ctx, 'outbox_messages')).toBe(before);
  });
});

describe('inbox', () => {
  const inbox = (messageId: string, payloadHash = 'hash-1') => ({
    consumerName: 'wager-consumer',
    messageId,
    payloadHash,
  });

  test('the same message delivered 20 times in parallel has a single effect', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet, { inbox: inbox('msg-1') });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => ctx.processor.execute({ ...command })),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(await count(ctx, 'inbox_messages')).toBe(1);
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);

    const [row] = await ctx.em.execute<Array<{ processed_at: string | null }>>(
      `select processed_at from inbox_messages`,
    );
    expect(row?.processed_at).not.toBeNull();
  });

  test('redelivery after the commit returns the original result', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet, { inbox: inbox('msg-2') });

    const first = await ctx.processor.execute(command);
    const second = await ctx.processor.execute(command);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance).toEqual(first.balance);
  });

  test('the same messageId with another payload hash is a conflict', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet, { inbox: inbox('msg-3', 'hash-a') });
    await ctx.processor.execute(command);

    await expect(
      ctx.processor.execute({ ...command, inbox: inbox('msg-3', 'hash-b') }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('different messages carrying the same business operation do not duplicate the debit', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const command = betCommand(wallet);

    await ctx.processor.execute({ ...command, inbox: inbox('msg-4a') });
    const second = await ctx.processor.execute({ ...command, inbox: inbox('msg-4b') });

    expect(second.idempotentReplay).toBe(true);
    expect(await count(ctx, 'inbox_messages')).toBe(2);
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
  });
});

describe('business validation', () => {
  test('wallet of another player is rejected and persisted for audit', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const stranger = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

    const result = await ctx.processor.execute(betCommand(wallet, { playerId: stranger }));

    expect(String(result.status)).toBe('REJECTED');
    expect(String(result.failureCode)).toBe('WALLET_PLAYER_MISMATCH');
    expect(result.balance.amount).toBe('100.00');
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(0);
  });

  test('currency different from the wallet is rejected', async () => {
    const wallet = await seedWallet(ctx, '100.00', 'BRL');

    const result = await ctx.processor.execute(
      betCommand(wallet, { money: { amount: '10.00', currency: 'USD' } }),
    );

    expect(String(result.status)).toBe('REJECTED');
    expect(String(result.failureCode)).toBe('CURRENCY_MISMATCH');
  });

  test('OPENING cannot be submitted', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    await expect(
      ctx.processor.execute(betCommand(wallet, { kind: 'OPENING' })),
    ).rejects.toBeInstanceOf(InvalidWagerTransactionError);
  });

  test('invalid money and malformed ids fail before touching the database', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const before = await count(ctx, 'wager_transactions');

    for (const money of [
      { amount: '1.234', currency: 'BRL' },
      { amount: '-1.00', currency: 'BRL' },
      { amount: '1e3', currency: 'BRL' },
      { amount: '', currency: 'BRL' },
      { amount: '1.00', currency: 'br' },
    ]) {
      await expect(ctx.processor.execute(betCommand(wallet, { money }))).rejects.toThrow();
    }

    await expect(
      ctx.processor.execute(betCommand(wallet, { walletId: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(InvalidWagerTransactionError);

    await expect(
      ctx.processor.execute(betCommand(wallet, { externalTransactionId: nextId('x'), roundId: ' ' })),
    ).rejects.toBeInstanceOf(InvalidWagerTransactionError);

    expect(await count(ctx, 'wager_transactions')).toBe(before);
  });

  test('unknown wallet is reported as WalletNotFoundError', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    await expect(
      ctx.processor.execute(
        betCommand(wallet, { walletId: '0192f291-27dd-7d3f-8071-5f8685deef37' }),
      ),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });
});
