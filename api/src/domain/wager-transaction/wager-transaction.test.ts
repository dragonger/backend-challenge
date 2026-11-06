import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../errors/domain-error.js';
import { FailureCode } from '../errors/failure-code.js';
import { Money } from '../money/money.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const make = (
  kind: WagerTransactionKind,
  extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    ...extra,
  });

describe('WagerTransaction', () => {
  test('is born PENDING', () => {
    const tx = make(WagerTransactionKind.Bet);

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.attempts).toBe(0);
  });

  test('OPENING cannot be created through the public factory', () => {
    expect(() => make(WagerTransactionKind.Opening)).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s requires a reference',
    (kind) => {
      expect(() => make(kind)).toThrow(InvalidWagerTransactionError);
      expect(() =>
        make(kind, { referenceExternalTransactionId: ' ' }),
      ).toThrow(InvalidWagerTransactionError);

      const tx = make(kind, { referenceExternalTransactionId: 'ext-0' });
      expect(tx.requiresReference()).toBe(true);
    },
  );

  test('BET cannot carry a reference; zero amount only for LOSS', () => {
    expect(() =>
      make(WagerTransactionKind.Bet, { referenceExternalTransactionId: 'x' }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() => make(WagerTransactionKind.Bet, { money: brl('0.00') })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      make(WagerTransactionKind.Loss, { money: brl('0.00') }),
    ).not.toThrow();
  });

  test('affectsBalance is false only for LOSS', () => {
    expect(make(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(make(WagerTransactionKind.Win).affectsBalance()).toBe(true);
    expect(make(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
  });

  test('markProcessed stores the snapshot', () => {
    const tx = make(WagerTransactionKind.Bet);

    tx.markProcessed(undefined, at, brl('75.00'));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(at);
    expect(tx.balanceAfter?.toString()).toBe('75.00 BRL');
    expect(tx.isTerminal()).toBe(true);
  });

  test('reject stores failure code and observed balance', () => {
    const tx = make(WagerTransactionKind.Bet);

    tx.reject(FailureCode.InsufficientBalance, at, brl('20.00'));

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(tx.balanceAfter?.toString()).toBe('20.00 BRL');
  });

  test('PENDING_REFERENCE counts attempts and can later be resolved', () => {
    const tx = make(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ext-0',
    });

    tx.markPendingReference(at, brl('10.00'));
    expect(tx.attempts).toBe(0);
    expect(tx.isPendingReference()).toBe(true);

    tx.markPendingReference(at, brl('10.00'));

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.isTerminal()).toBe(false);

    tx.markProcessed('tx-0', at, brl('35.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test.each(['processed', 'rejected', 'failed'] as const)(
    'terminal state (%s) rejects every transition',
    (terminal) => {
      const tx = make(WagerTransactionKind.Bet);

      if (terminal === 'processed') tx.markProcessed(undefined, at, brl('1.00'));
      if (terminal === 'rejected')
        tx.reject(FailureCode.InsufficientBalance, at, brl('1.00'));
      if (terminal === 'failed') tx.fail(FailureCode.InternalError, at);

      expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference(at, brl('1.00'))).toThrow(
        InvalidTransactionStateError,
      );
      expect(() =>
        tx.reject(FailureCode.InsufficientBalance, at, brl('1.00')),
      ).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.InternalError, at)).toThrow(
        InvalidTransactionStateError,
      );
    },
  );

  test('matchesPayload compares the hash', () => {
    const tx = make(WagerTransactionKind.Bet);

    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('other')).toBe(false);
  });

  test('ledger direction per kind, ROLLBACK inverts the reference', () => {
    const bet = make(WagerTransactionKind.Bet);
    const win = make(WagerTransactionKind.Win);
    const refund = make(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'r',
    });
    const rollback = make(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'r',
    });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      make(WagerTransactionKind.Loss).ledgerDirectionFor(),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('rehydrate keeps persisted state without revalidating', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx',
      providerId: 'p',
      externalTransactionId: 'e',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'w',
      playerId: 'pl',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Refund,
      money: brl('1.00'),
      referenceExternalTransactionId: undefined,
      createdAt: at,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      processedAt: at,
      attempts: 5,
    });

    expect(tx.isTerminal()).toBe(true);
    expect(tx.attempts).toBe(5);
  });
});
