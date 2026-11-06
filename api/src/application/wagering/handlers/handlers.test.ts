import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../domain/errors/failure-code.js';
import { Money } from '../../../domain/money/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.js';
import { Wallet } from '../../../domain/wallet/wallet.js';
import { LedgerDirection } from '../../../domain/wallet/wallet-ledger-entry.js';
import { PendingReferencePolicy } from '../pending-reference.policy.js';
import { BetHandler } from './bet.handler.js';
import type { KindHandler, KindHandlerContext, ReferenceLookup } from './handler.js';
import { LossHandler } from './loss.handler.js';
import { RefundHandler } from './refund.handler.js';
import { RollbackHandler } from './rollback.handler.js';
import { WinHandler } from './win.handler.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00.000Z');
const POLICY = new PendingReferencePolicy(
  {
    initialBackoffMs: 1000,
    maxBackoffMs: 8000,
    maxAttempts: 3,
    ttlMs: 60_000,
    jitterRatio: 0,
  },
  () => 0.5,
);

const ids = { wallet: 'wallet-1', player: 'player-1' };

const wallet = (balance: string) =>
  Wallet.open({
    id: ids.wallet,
    playerId: ids.player,
    initialBalance: brl(balance),
    now: t0,
  });

const stored = (
  kind: WagerTransactionKind,
  amount: string,
  status = WagerTransactionStatus.Processed,
  extra: Partial<Parameters<typeof WagerTransaction.rehydrate>[0]> = {},
) =>
  WagerTransaction.rehydrate({
    id: `id-${kind}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind}`,
    idempotencyKey: `key-${kind}`,
    payloadHash: 'h',
    walletId: ids.wallet,
    playerId: ids.player,
    roundId: 'round-1',
    gameId: 'game',
    kind,
    money: brl(amount),
    createdAt: t0,
    status,
    attempts: 0,
    ...extra,
  });

const incoming = (
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>,
  amount: string,
  referenceKind?: WagerTransactionKind,
) =>
  WagerTransaction.create({
    id: 'new-id',
    providerId: 'provider-a',
    externalTransactionId: 'new-ext',
    idempotencyKey: 'new-key',
    payloadHash: 'h2',
    walletId: ids.wallet,
    playerId: ids.player,
    roundId: 'round-1',
    gameId: 'game',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: referenceKind ? `ext-${referenceKind}` : undefined,
    createdAt: t0,
  });

class FakeReferences implements ReferenceLookup {
  constructor(
    private readonly reference: WagerTransaction | null,
    private readonly reversed = false,
  ) {}

  find(): Promise<WagerTransaction | null> {
    return Promise.resolve(this.reference);
  }

  isReversed(): Promise<boolean> {
    return Promise.resolve(this.reversed);
  }
}

let entryCounter = 0;

const run = async (
  handler: KindHandler,
  transaction: WagerTransaction,
  w: Wallet,
  references: ReferenceLookup,
  now = t0,
) => {
  const context: KindHandlerContext = {
    transaction,
    wallet: w,
    now,
    newId: () => `entry-${(entryCounter += 1)}`,
    references,
    policy: POLICY,
  };

  return handler.handle(context);
};

describe('BetHandler', () => {
  test('debits and processes', async () => {
    const w = wallet('100.00');
    const tx = incoming(WagerTransactionKind.Bet, '30.00');
    const outcome = await run(new BetHandler(), tx, w, new FakeReferences(null));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe('70.00');
  });

  test('rejects INSUFFICIENT_BALANCE without ledger', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Bet, '30.00');
    const outcome = await run(new BetHandler(), tx, w, new FakeReferences(null));

    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(outcome.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('10.00');
    expect(w.version).toBe(1);
  });
});

describe('WinHandler', () => {
  test('without reference: credits', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Win, '40.00');
    const outcome = await run(new WinHandler(), tx, w, new FakeReferences(null));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('50.00');
  });

  test('with a processed BET of the round: credits and links the reference', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Win, '40.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '10.00');
    const outcome = await run(new WinHandler(), tx, w, new FakeReferences(bet));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe(bet.id);
    expect(outcome.ledgerEntry).toBeDefined();
  });

  test('reference to a missing BET waits as PENDING_REFERENCE with attempts 0', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Win, '40.00', WagerTransactionKind.Bet);
    const outcome = await run(new WinHandler(), tx, w, new FakeReferences(null));

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.attempts).toBe(0);
    expect(tx.nextAttemptAt?.getTime()).toBe(t0.getTime() + 1000);
    expect(outcome.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('10.00');
  });

  test('reference to a REJECTED BET: REFERENCE_NOT_PROCESSED', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Win, '40.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '10.00', WagerTransactionStatus.Rejected);
    await run(new WinHandler(), tx, w, new FakeReferences(bet));

    expect(tx.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('reference of another kind: INVALID_REFERENCE_KIND', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Win, '40.00', WagerTransactionKind.Win);
    const other = stored(WagerTransactionKind.Win, '40.00');
    await run(new WinHandler(), tx, w, new FakeReferences(other));

    expect(tx.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('reference from another round: REFERENCE_MISMATCH', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Win, '40.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '10.00', WagerTransactionStatus.Processed, {
      roundId: 'round-2',
    });
    await run(new WinHandler(), tx, w, new FakeReferences(bet));

    expect(tx.failureCode).toBe(FailureCode.ReferenceMismatch);
  });
});

describe('LossHandler', () => {
  test('processes without moving the balance or creating a ledger entry', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Loss, '0.00');
    const outcome = await run(new LossHandler(), tx, w, new FakeReferences(null));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.affectsBalance()).toBe(false);
    expect(outcome.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('with a processed BET reference links it', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Loss, '0.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '10.00');
    await run(new LossHandler(), tx, w, new FakeReferences(bet));

    expect(tx.referenceTransactionId).toBe(bet.id);
  });

  test('with a missing reference waits', async () => {
    const tx = incoming(WagerTransactionKind.Loss, '0.00', WagerTransactionKind.Bet);
    await run(new LossHandler(), tx, wallet('10.00'), new FakeReferences(null));

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe('RefundHandler', () => {
  test('credits the amount of a processed BET', async () => {
    const w = wallet('70.00');
    const tx = incoming(WagerTransactionKind.Refund, '30.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '30.00');
    const outcome = await run(new RefundHandler(), tx, w, new FakeReferences(bet));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe(bet.id);
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  test('missing BET: PENDING_REFERENCE, no balance change', async () => {
    const w = wallet('70.00');
    const tx = incoming(WagerTransactionKind.Refund, '30.00', WagerTransactionKind.Bet);
    const outcome = await run(new RefundHandler(), tx, w, new FakeReferences(null));

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(outcome.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('70.00');
  });

  test('BET still pending: PENDING_REFERENCE', async () => {
    const tx = incoming(WagerTransactionKind.Refund, '30.00', WagerTransactionKind.Bet);
    const bet = stored(
      WagerTransactionKind.Bet,
      '30.00',
      WagerTransactionStatus.PendingReference,
    );
    await run(new RefundHandler(), tx, wallet('70.00'), new FakeReferences(bet));

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('amount different from the BET: AMOUNT_MISMATCH', async () => {
    const tx = incoming(WagerTransactionKind.Refund, '29.99', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '30.00');
    await run(new RefundHandler(), tx, wallet('70.00'), new FakeReferences(bet));

    expect(tx.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test('refund of a WIN: INVALID_REFERENCE_KIND', async () => {
    const tx = incoming(WagerTransactionKind.Refund, '30.00', WagerTransactionKind.Win);
    const win = stored(WagerTransactionKind.Win, '30.00');
    await run(new RefundHandler(), tx, wallet('70.00'), new FakeReferences(win));

    expect(tx.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('BET already reversed: REFERENCE_ALREADY_REVERSED', async () => {
    const w = wallet('70.00');
    const tx = incoming(WagerTransactionKind.Refund, '30.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '30.00');
    const outcome = await run(new RefundHandler(), tx, w, new FakeReferences(bet, true));

    expect(tx.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(outcome.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('70.00');
  });
});

describe('RollbackHandler', () => {
  test('rollback of a BET credits', async () => {
    const w = wallet('70.00');
    const tx = incoming(WagerTransactionKind.Rollback, '30.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '30.00');
    const outcome = await run(new RollbackHandler(), tx, w, new FakeReferences(bet));

    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  test.each([WagerTransactionKind.Win, WagerTransactionKind.Refund])(
    'rollback of a %s debits',
    async (referenceKind) => {
      const w = wallet('100.00');
      const tx = incoming(WagerTransactionKind.Rollback, '30.00', referenceKind);
      const ref = stored(referenceKind, '30.00');
      const outcome = await run(new RollbackHandler(), tx, w, new FakeReferences(ref));

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(w.balance.toJSON().amount).toBe('70.00');
    },
  );

  test('rollback of a WIN that would overdraw: REVERSAL_WOULD_OVERDRAW, no ledger', async () => {
    const w = wallet('10.00');
    const tx = incoming(WagerTransactionKind.Rollback, '30.00', WagerTransactionKind.Win);
    const win = stored(WagerTransactionKind.Win, '30.00');
    const outcome = await run(new RollbackHandler(), tx, w, new FakeReferences(win));

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(tx.failureCode).not.toBe(FailureCode.InsufficientBalance);
    expect(outcome.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test.each([WagerTransactionKind.Rollback, WagerTransactionKind.Loss])(
    'rollback of a %s is forbidden',
    async (referenceKind) => {
      const tx = incoming(WagerTransactionKind.Rollback, '30.00', referenceKind);
      const ref = stored(referenceKind, '30.00');
      await run(new RollbackHandler(), tx, wallet('100.00'), new FakeReferences(ref));

      expect(tx.failureCode).toBe(FailureCode.InvalidReferenceKind);
    },
  );

  test('already reversed reference: REFERENCE_ALREADY_REVERSED', async () => {
    const tx = incoming(WagerTransactionKind.Rollback, '30.00', WagerTransactionKind.Bet);
    const bet = stored(WagerTransactionKind.Bet, '30.00');
    await run(new RollbackHandler(), tx, wallet('70.00'), new FakeReferences(bet, true));

    expect(tx.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });
});

describe('PENDING_REFERENCE re-attempts', () => {
  const pendingRefund = (attempts: number, createdAt = t0) =>
    WagerTransaction.rehydrate({
      id: 'p-id',
      providerId: 'provider-a',
      externalTransactionId: 'p-ext',
      idempotencyKey: 'p-key',
      payloadHash: 'h',
      walletId: ids.wallet,
      playerId: ids.player,
      roundId: 'round-1',
      gameId: 'game',
      kind: WagerTransactionKind.Refund,
      money: brl('30.00'),
      referenceExternalTransactionId: `ext-${WagerTransactionKind.Bet}`,
      createdAt,
      status: WagerTransactionStatus.PendingReference,
      attempts,
      nextAttemptAt: t0,
    });

  test('still missing: attempts +1 and rescheduled with exponential backoff', async () => {
    const tx = pendingRefund(0);
    await run(new RefundHandler(), tx, wallet('70.00'), new FakeReferences(null), t0);

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt?.getTime()).toBe(t0.getTime() + 2000);
  });

  test('reaching the attempt limit: REJECTED REFERENCE_NOT_FOUND', async () => {
    const tx = pendingRefund(2);
    await run(new RefundHandler(), tx, wallet('70.00'), new FakeReferences(null), t0);

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('reaching the TTL: REJECTED REFERENCE_NOT_FOUND even with few attempts', async () => {
    const tx = pendingRefund(0);
    const later = new Date(t0.getTime() + 60_000);
    await run(new RefundHandler(), tx, wallet('70.00'), new FakeReferences(null), later);

    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('reference arrived: processed', async () => {
    const w = wallet('70.00');
    const tx = pendingRefund(4);
    const bet = stored(WagerTransactionKind.Bet, '30.00');
    const outcome = await run(new RefundHandler(), tx, w, new FakeReferences(bet));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(outcome.ledgerEntry).toBeDefined();
    expect(w.balance.toJSON().amount).toBe('100.00');
  });
});
