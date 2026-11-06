import { randomUUID } from 'node:crypto';
import type { ProcessWagerTransactionCommand } from '../../src/application/wagering/commands.js';
import type { TestContext } from './db.js';

let counter = 0;

export const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
};

export interface SeededWallet {
  walletId: string;
  playerId: string;
}

export async function seedWallet(
  ctx: TestContext,
  balance = '100.00',
  currency = 'BRL',
  playerId: string = randomUUID(),
): Promise<SeededWallet> {
  const wallet = await ctx.openWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency },
  });

  return { walletId: wallet.id, playerId };
}

export function betCommand(
  wallet: SeededWallet,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId =
    overrides.externalTransactionId ?? nextId('ext');

  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export async function count(
  ctx: TestContext,
  table: string,
  where = 'true',
): Promise<number> {
  const rows = await ctx.em.execute<Array<{ n: string }>>(
    `select count(*)::text as n from ${table} where ${where}`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function walletState(
  ctx: TestContext,
  walletId: string,
): Promise<{ balance: string; version: number }> {
  const rows = await ctx.em.execute<Array<{ balance: string; version: number }>>(
    `select balance::text as balance, version from wallets where id = ?`,
    [walletId],
  );
  const row = rows[0];

  if (!row) {
    throw new Error('wallet not found');
  }

  return row;
}

/** Any kind; REFUND / ROLLBACK / WIN / LOSS may carry a reference. */
export function operation(
  wallet: SeededWallet,
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
  amount: string,
  referenceExternalTransactionId?: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return betCommand(wallet, {
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId }
      : {}),
    ...overrides,
  });
}

export async function txRow(
  ctx: TestContext,
  transactionId: string,
): Promise<{
  status: string;
  failure_code: string | null;
  attempts: number;
  reference_transaction_id: string | null;
  balance_after: string | null;
  next_attempt_at: Date | null;
}> {
  const rows = await ctx.em.execute<
    Array<{
      status: string;
      failure_code: string | null;
      attempts: number;
      reference_transaction_id: string | null;
      balance_after: string | null;
      next_attempt_at: Date | null;
    }>
  >(
    `select status, failure_code, attempts, reference_transaction_id,
            balance_after::text as balance_after, next_attempt_at
       from wager_transactions where id = ?`,
    [transactionId],
  );
  const row = rows[0];

  if (!row) {
    throw new Error('transaction not found');
  }

  return {
    ...row,
    next_attempt_at: row.next_attempt_at ? new Date(row.next_attempt_at) : null,
  };
}

export async function eventTypesOf(
  ctx: TestContext,
  aggregateId?: string,
): Promise<string[]> {
  const rows = aggregateId
    ? await ctx.em.execute<Array<{ event_type: string }>>(
        `select event_type from outbox_messages where aggregate_id = ? order by sequence`,
        [aggregateId],
      )
    : await ctx.em.execute<Array<{ event_type: string }>>(
        `select event_type from outbox_messages order by sequence`,
      );

  return rows.map((row) => row.event_type);
}
