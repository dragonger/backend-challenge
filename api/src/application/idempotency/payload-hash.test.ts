import { describe, expect, test } from 'bun:test';
import { canonicalJson } from './canonical-json.js';
import { computePayloadHash, type PayloadHashInput } from './payload-hash.js';

const base: PayloadHashInput = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: 'p',
  walletId: 'w',
  roundId: 'r',
  gameId: 'g',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys recursively and is independent of insertion order', () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'z' } };
    const b = { a: { c: 'z', d: [3, { x: 2, y: 1 }] }, b: 1 };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"z","d":[3,{"x":2,"y":1}]},"b":1}');
  });

  test('keeps array order and drops undefined properties', () => {
    expect(canonicalJson({ list: [2, 1], gone: undefined })).toBe('{"list":[2,1]}');
  });
});

describe('computePayloadHash', () => {
  test('is a SHA-256 hex digest', () => {
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on the order of the keys', () => {
    const shuffled: PayloadHashInput = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'g',
      roundId: 'r',
      walletId: 'w',
      playerId: 'p',
      externalTransactionId: 'tx-1',
      providerId: 'provider-a',
    };

    expect(computePayloadHash(shuffled)).toBe(computePayloadHash(base));
  });

  test('ignores fields that are not business fields', () => {
    const noisy = {
      ...base,
      idempotencyKey: 'whatever',
      messageId: 'm-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
    } as PayloadHashInput;

    expect(computePayloadHash(noisy)).toBe(computePayloadHash(base));
  });

  test.each([
    ['providerId', { providerId: 'b' }],
    ['externalTransactionId', { externalTransactionId: 'tx-2' }],
    ['playerId', { playerId: 'q' }],
    ['walletId', { walletId: 'x' }],
    ['roundId', { roundId: 'r2' }],
    ['gameId', { gameId: 'g2' }],
    ['kind', { kind: 'WIN' }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['reference', { referenceExternalTransactionId: 'ref-1' }],
  ])('changes when %s changes', (_name, change) => {
    expect(computePayloadHash({ ...base, ...change })).not.toBe(computePayloadHash(base));
  });

  test('an absent or empty reference hashes the same', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(base),
    );
  });
});
