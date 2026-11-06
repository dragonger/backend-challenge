import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../errors/failure-code.js';
import { Money } from '../money/money.js';
import { evaluateReference } from './reference-rules.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const base = {
  providerId: 'provider-a',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  payloadHash: 'hash',
  createdAt: at,
};

const reference = (
  kind: WagerTransactionKind,
  status: WagerTransactionStatus,
  extra: Partial<Parameters<typeof WagerTransaction.rehydrate>[0]> = {},
) =>
  WagerTransaction.rehydrate({
    ...base,
    id: 'ref-id',
    externalTransactionId: 'ref-ext',
    idempotencyKey: 'provider-a:ref-ext',
    kind,
    money: brl('25.00'),
    status,
    attempts: 0,
    ...extra,
  });

const operation = (
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>,
  extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) =>
  WagerTransaction.create({
    ...base,
    id: 'op-id',
    externalTransactionId: 'op-ext',
    idempotencyKey: 'provider-a:op-ext',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId: 'ref-ext',
    ...extra,
  });

const processedBet = () =>
  reference(WagerTransactionKind.Bet, WagerTransactionStatus.Processed);

describe('evaluateReference: valid combinations', () => {
  test.each([
    [WagerTransactionKind.Win, WagerTransactionKind.Bet],
    [WagerTransactionKind.Loss, WagerTransactionKind.Bet],
    [WagerTransactionKind.Refund, WagerTransactionKind.Bet],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Bet],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Win],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Refund],
  ] as const)('%s may reference a PROCESSED %s', (kind, referenceKind) => {
    const result = evaluateReference(
      operation(kind),
      reference(referenceKind, WagerTransactionStatus.Processed),
    );

    expect(result).toEqual({ verdict: 'OK' });
  });
});

describe('evaluateReference: INVALID_REFERENCE_KIND', () => {
  test.each([
    [WagerTransactionKind.Win, WagerTransactionKind.Win],
    [WagerTransactionKind.Win, WagerTransactionKind.Refund],
    [WagerTransactionKind.Loss, WagerTransactionKind.Win],
    [WagerTransactionKind.Refund, WagerTransactionKind.Win],
    [WagerTransactionKind.Refund, WagerTransactionKind.Refund],
    [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Rollback],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Loss],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Opening],
  ] as const)('%s cannot reference a %s', (kind, referenceKind) => {
    const result = evaluateReference(
      operation(kind),
      reference(referenceKind, WagerTransactionStatus.Processed),
    );

    expect(result).toEqual({
      verdict: 'REJECT',
      code: FailureCode.InvalidReferenceKind,
    });
  });
});

describe('evaluateReference: REFERENCE_MISMATCH', () => {
  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['round', { roundId: 'round-2' }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
  ] as const)('different %s', (_name, override) => {
    const result = evaluateReference(
      operation(WagerTransactionKind.Refund),
      reference(WagerTransactionKind.Bet, WagerTransactionStatus.Processed, override),
    );

    expect(result).toEqual({
      verdict: 'REJECT',
      code: FailureCode.ReferenceMismatch,
    });
  });

  test('mismatch wins over a pending reference (definitive answer first)', () => {
    const result = evaluateReference(
      operation(WagerTransactionKind.Refund),
      reference(WagerTransactionKind.Bet, WagerTransactionStatus.PendingReference, {
        roundId: 'other',
      }),
    );

    expect(result).toEqual({
      verdict: 'REJECT',
      code: FailureCode.ReferenceMismatch,
    });
  });
});

describe('evaluateReference: reference status', () => {
  test.each([WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed])(
    '%s reference is REFERENCE_NOT_PROCESSED',
    (status) => {
      const result = evaluateReference(
        operation(WagerTransactionKind.Refund),
        reference(WagerTransactionKind.Bet, status),
      );

      expect(result).toEqual({
        verdict: 'REJECT',
        code: FailureCode.ReferenceNotProcessed,
      });
    },
  );

  test.each([
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference,
  ])('%s reference makes the new transaction wait', (status) => {
    const result = evaluateReference(
      operation(WagerTransactionKind.Rollback),
      reference(WagerTransactionKind.Refund, status),
    );

    expect(result).toEqual({ verdict: 'WAIT' });
  });
});

describe('evaluateReference: amount', () => {
  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s must have the same amount as the reference',
    (kind) => {
      const result = evaluateReference(
        operation(kind, { money: brl('24.99') }),
        processedBet(),
      );

      expect(result).toEqual({
        verdict: 'REJECT',
        code: FailureCode.AmountMismatch,
      });
    },
  );

  test('"25" and "25.00" are the same amount', () => {
    const result = evaluateReference(
      operation(WagerTransactionKind.Refund, {
        money: Money.from({ amount: '25', currency: 'BRL' }),
      }),
      processedBet(),
    );

    expect(result).toEqual({ verdict: 'OK' });
  });

  test.each([WagerTransactionKind.Win, WagerTransactionKind.Loss])(
    '%s may have a different amount than its BET',
    (kind) => {
      const result = evaluateReference(
        operation(kind, { money: brl('500.00') }),
        processedBet(),
      );

      expect(result).toEqual({ verdict: 'OK' });
    },
  );
});
