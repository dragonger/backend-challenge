import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  closeTestContext,
  createTestContext,
  resetDatabase,
  type TestContext,
} from '../helpers/db.js';
import { betCommand, count, nextId, seedWallet } from '../helpers/factories.js';
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

interface TxRow {
  id?: string;
  walletId: string;
  playerId: string;
  kind?: string;
  status?: string;
  amount?: string;
  externalId?: string;
  key?: string;
  referenceExternal?: string | null;
  referenceId?: string | null;
  failureCode?: string | null;
  processedAt?: Date | null;
  balanceAfter?: string | null;
  nextAttemptAt?: Date | null;
}

async function insertTx(em: EntityManager, row: TxRow): Promise<string> {
  const id = row.id ?? randomUUID();
  const external = row.externalId ?? nextId('raw');

  await em.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
        reference_external_transaction_id, reference_transaction_id, failure_code,
        processed_at, balance_after, next_attempt_at)
     values (?, 'provider-a', ?, ?, 'hash', ?, ?, 'round-1', 'game-1', ?, ?, 'BRL', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      external,
      row.key ?? external,
      row.walletId,
      row.playerId,
      row.kind ?? 'BET',
      row.amount ?? '10.00',
      row.status ?? 'PENDING',
      row.referenceExternal ?? null,
      row.referenceId ?? null,
      row.failureCode ?? null,
      row.processedAt ?? null,
      row.balanceAfter ?? null,
      row.nextAttemptAt ?? null,
    ],
  );

  return id;
}

/** Expects the statement to fail with a given SQLSTATE and constraint/index. */
async function expectDbError(
  work: () => Promise<unknown>,
  sqlState: string,
  constraint?: string,
): Promise<void> {
  const error = await work().then(
    () => undefined,
    (e: unknown) => e as { code?: string; constraint?: string; message?: string },
  );

  expect(error).toBeDefined();
  expect(error?.code).toBe(sqlState);

  if (constraint) {
    expect(`${error?.constraint ?? ''} ${error?.message ?? ''}`).toContain(constraint);
  }
}

describe('wallets', () => {
  test('balance can never be negative', async () => {
    const wallet = await seedWallet(ctx, '10.00');

    await expectDbError(
      () => ctx.em.execute(`update wallets set balance = -0.01 where id = ?`, [wallet.walletId]),
      '23514',
      'wallets_balance_non_negative',
    );
  });

  test('one wallet per player and currency', async () => {
    const wallet = await seedWallet(ctx, '10.00');

    await expectDbError(
      () =>
        ctx.em.execute(
          `insert into wallets (id, player_id, currency, balance) values (?, ?, 'BRL', 0)`,
          [randomUUID(), wallet.playerId],
        ),
      '23505',
    );
  });
});

describe('wager_transactions', () => {
  test('REFUND and ROLLBACK require a reference', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectDbError(
        () => insertTx(ctx.em, { ...wallet, kind, referenceExternal: null }),
        '23514',
        'wager_transactions_reversal_requires_reference',
      );
    }
  });

  test('idempotency key and provider transaction id are unique', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    await insertTx(ctx.em, { ...wallet, externalId: 'dup-1', key: 'key-1' });

    await expectDbError(
      () => insertTx(ctx.em, { ...wallet, externalId: 'dup-2', key: 'key-1' }),
      '23505',
      'idempotency_key',
    );
    await expectDbError(
      () => insertTx(ctx.em, { ...wallet, externalId: 'dup-1', key: 'key-2' }),
      '23505',
      'external_transaction_id',
    );
  });

  test('reference_transaction_id must point to an existing transaction', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    await expectDbError(
      () =>
        insertTx(ctx.em, {
          ...wallet,
          kind: 'REFUND',
          referenceExternal: 'x',
          referenceId: randomUUID(),
        }),
      '23503',
    );
  });

  test('a transaction can be reversed only once, by REFUND or by ROLLBACK', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await ctx.processor.execute(betCommand(wallet));

    const reversal = (kind: string, external: string) => ({
      ...wallet,
      kind,
      status: 'PROCESSED',
      processedAt: new Date(),
      balanceAfter: '100.00',
      referenceExternal: 'bet',
      referenceId: bet.transactionId,
      externalId: external,
    });

    for (const [first, second] of [
      ['REFUND', 'REFUND'],
      ['REFUND', 'ROLLBACK'],
      ['ROLLBACK', 'REFUND'],
      ['ROLLBACK', 'ROLLBACK'],
    ] as const) {
      // Both inserts run in one SQL transaction that is aborted by the second:
      // the first row is rolled back, so the database stays consistent.
      await expectDbError(
        () =>
          ctx.em.fork().transactional(async (tx) => {
            await insertTx(tx, reversal(first, nextId('rev')));
            await insertTx(tx, reversal(second, nextId('rev')));
          }),
        '23505',
        'wager_transactions_one_reversal_per_reference',
      );
    }

    expect(await count(ctx, 'wager_transactions', `kind in ('REFUND','ROLLBACK')`)).toBe(0);
  });

  test('a rejected reversal does not consume the single reversal slot', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await ctx.processor.execute(betCommand(wallet));
    const base = {
      ...wallet,
      kind: 'REFUND',
      referenceExternal: 'bet',
      referenceId: bet.transactionId,
      processedAt: new Date(),
      balanceAfter: '90.00',
    };

    await insertTx(ctx.em, { ...base, status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
    await insertTx(ctx.em, { ...base, status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH' });

    expect(await count(ctx, 'wager_transactions', `status = 'REJECTED'`)).toBe(2);
  });

  test('status consistency rules', async () => {
    const wallet = await seedWallet(ctx, '100.00');

    await expectDbError(
      () => insertTx(ctx.em, { ...wallet, status: 'PROCESSED', processedAt: new Date() }),
      '23514',
      'processed_has_snapshot',
    );
    await expectDbError(
      () =>
        insertTx(ctx.em, {
          ...wallet,
          status: 'REJECTED',
          processedAt: new Date(),
          balanceAfter: '1.00',
        }),
      '23514',
      'failed_has_code',
    );
    await expectDbError(
      () =>
        insertTx(ctx.em, {
          ...wallet,
          status: 'REJECTED',
          failureCode: 'INSUFFICIENT_BALANCE',
        }),
      '23514',
      'terminal_has_processed_at',
    );
    await expectDbError(
      () =>
        insertTx(ctx.em, {
          ...wallet,
          kind: 'WIN',
          status: 'PENDING_REFERENCE',
          nextAttemptAt: null,
        }),
      '23514',
      'pending_reference_scheduled',
    );
    await expectDbError(
      () => insertTx(ctx.em, { ...wallet, kind: 'BET', amount: '0.00' }),
      '23514',
      'amount_positive_except_loss',
    );
  });
});

describe('wallet_ledger_entries', () => {
  async function anyTransaction() {
    const wallet = await seedWallet(ctx, '100.00');
    const bet = await ctx.processor.execute(betCommand(wallet));
    return { wallet, transactionId: bet.transactionId };
  }

  const insertEntry = (
    walletId: string,
    transactionId: string,
    direction: string,
    amount: string,
    before: string,
    after: string,
  ) =>
    ctx.em.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values (?, ?, ?, ?, ?, 'BRL', ?, ?)`,
      [randomUUID(), walletId, transactionId, direction, amount, before, after],
    );

  test('arithmetic must balance', async () => {
    const { wallet, transactionId } = await anyTransaction();
    const other = await ctx.processor.execute(betCommand(wallet));

    await expectDbError(
      () => insertEntry(wallet.walletId, other.transactionId, 'DEBIT', '10.00', '80.00', '71.00'),
      '23514',
      'wallet_ledger_entries_balance_check',
    );
    expect(transactionId).toBeDefined();
  });

  test('at most one entry per wallet and transaction', async () => {
    const { wallet, transactionId } = await anyTransaction();

    await expectDbError(
      () => insertEntry(wallet.walletId, transactionId, 'DEBIT', '10.00', '80.00', '70.00'),
      '23505',
      'wallet_ledger_entries_wallet_transaction_unique',
    );
  });

  test('amount must be positive and balances non negative', async () => {
    const { wallet } = await anyTransaction();
    const other = await ctx.processor.execute(betCommand(wallet));

    await expectDbError(
      () => insertEntry(wallet.walletId, other.transactionId, 'DEBIT', '0.00', '80.00', '80.00'),
      '23514',
      'wallet_ledger_entries_positive_amount',
    );
  });

  test('the sequence column orders entries', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    await ctx.processor.execute(betCommand(wallet));
    await ctx.processor.execute(betCommand(wallet));

    const rows = await ctx.em.execute<Array<{ sequence: string }>>(
      `select sequence::text from wallet_ledger_entries order by sequence`,
    );
    const values = rows.map((r) => Number(r.sequence));

    expect(values).toHaveLength(3);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(3);
  });
});

describe('ledger immutability (trigger)', () => {
  test('UPDATE and DELETE are blocked', async () => {
    const wallet = await seedWallet(ctx, '100.00');
    await ctx.processor.execute(betCommand(wallet));

    await expectDbError(
      () => ctx.em.execute(`update wallet_ledger_entries set amount = 1`),
      'P0001',
      'cannot be updated or deleted',
    );
    await expectDbError(
      () => ctx.em.execute(`delete from wallet_ledger_entries`),
      'P0001',
      'cannot be updated or deleted',
    );
    await expectDbError(
      () => ctx.em.execute(`update wallet_ledger_entries set created_at = now()`),
      'P0001',
    );

    expect(await count(ctx, 'wallet_ledger_entries')).toBe(2);
  });
});

describe('inbox_messages', () => {
  test('(consumer_name, message_id) is the primary key', async () => {
    const insert = (consumer: string, message: string) =>
      ctx.em.execute(
        `insert into inbox_messages (consumer_name, message_id, payload_hash) values (?, ?, 'h')`,
        [consumer, message],
      );

    await insert('consumer-a', 'm1');
    await insert('consumer-b', 'm1');
    await insert('consumer-a', 'm2');

    await expectDbError(() => insert('consumer-a', 'm1'), '23505', 'inbox_messages_pkey');
  });
});

describe('outbox_messages', () => {
  test('pending index only covers unpublished rows', async () => {
    const [index] = await ctx.em.execute<Array<{ indexdef: string }>>(
      `select indexdef from pg_indexes where indexname = 'outbox_messages_pending_idx'`,
    );

    expect(index?.indexdef).toContain('published_at IS NULL');
  });

  test('ids are unique (eventId)', async () => {
    const id = randomUUID();
    const insert = () =>
      ctx.em.execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload) values (?, 'agg', 'T', '{}'::jsonb)`,
        [id],
      );

    await insert();
    await expectDbError(insert, '23505');
  });
});
