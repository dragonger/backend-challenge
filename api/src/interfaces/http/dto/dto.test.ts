import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RequestValidationError, ZodValidationPipe } from '../validation/zod.pipe.js';
import { idempotencyKeySchema } from './common.js';
import { createWalletSchema, ledgerQuerySchema } from './wallet.dto.js';
import { submitTransactionSchema } from './wager.dto.js';

const validBody = () => ({
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: randomUUID(),
  walletId: randomUUID(),
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

const submit = new ZodValidationPipe(submitTransactionSchema);

describe('submitTransactionSchema', () => {
  test('accepts a valid body, with and without reference', () => {
    expect(submit.transform(validBody())).toMatchObject({ kind: 'BET' });
    expect(
      submit.transform({ ...validBody(), kind: 'REFUND', referenceExternalTransactionId: 'r' }),
    ).toMatchObject({ referenceExternalTransactionId: 'r' });
  });

  test.each([
    ['unknown field', { extra: 1 }],
    ['OPENING kind', { kind: 'OPENING' }],
    ['lowercase kind', { kind: 'bet' }],
    ['numeric amount (no coercion)', { money: { amount: 25, currency: 'BRL' } }],
    ['bad currency', { money: { amount: '25.00', currency: 'brl' } }],
    ['extra money field', { money: { amount: '25.00', currency: 'BRL', x: 1 } }],
    ['bad playerId', { playerId: 'nope' }],
    ['bad walletId', { walletId: 'nope' }],
    ['blank providerId', { providerId: '   ' }],
    ['too long roundId', { roundId: 'x'.repeat(151) }],
    ['empty reference', { referenceExternalTransactionId: '' }],
  ])('rejects %s', (_name, override) => {
    expect(() => submit.transform({ ...validBody(), ...override })).toThrow(
      RequestValidationError,
    );
  });

  test('rejects a missing field and a non-object body', () => {
    const { gameId: _gameId, ...missing } = validBody();

    expect(() => submit.transform(missing)).toThrow(RequestValidationError);
    expect(() => submit.transform(undefined)).toThrow(RequestValidationError);
    expect(() => submit.transform('text')).toThrow(RequestValidationError);
  });

  test('error lists the offending paths', () => {
    try {
      submit.transform({ ...validBody(), money: { amount: 1, currency: 'BRL' } });
      throw new Error('should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect((error as RequestValidationError).issues[0]?.path).toBe('money.amount');
    }
  });
});

describe('createWalletSchema', () => {
  const pipe = new ZodValidationPipe(createWalletSchema);

  test('valid and invalid', () => {
    const body = {
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    };

    expect(pipe.transform(body)).toEqual(body);
    expect(() => pipe.transform({ ...body, extra: true })).toThrow(RequestValidationError);
    expect(() => pipe.transform({ ...body, playerId: 'x' })).toThrow(RequestValidationError);
    expect(() =>
      pipe.transform({ ...body, initialBalance: { amount: 10, currency: 'BRL' } }),
    ).toThrow(RequestValidationError);
  });
});

describe('ledgerQuerySchema', () => {
  const pipe = new ZodValidationPipe(ledgerQuerySchema);

  test('defaults the limit to 50', () => {
    expect(pipe.transform({})).toEqual({ limit: 50 });
  });

  test('parses digits explicitly', () => {
    expect(pipe.transform({ limit: '200', cursor: 'abc' })).toEqual({
      limit: 200,
      cursor: 'abc',
    });
  });

  test.each([['0'], ['201'], ['-1'], ['1.5'], ['abc'], ['1e2'], ['']])(
    'rejects limit %p',
    (limit) => {
      expect(() => pipe.transform({ limit })).toThrow(RequestValidationError);
    },
  );

  test('rejects unknown query params and repeated values', () => {
    expect(() => pipe.transform({ foo: '1' })).toThrow(RequestValidationError);
    expect(() => pipe.transform({ limit: ['1', '2'] })).toThrow(RequestValidationError);
  });
});

describe('idempotencyKeySchema', () => {
  const pipe = new ZodValidationPipe(idempotencyKeySchema);

  test('requires a non-blank string up to 255 chars', () => {
    expect(pipe.transform('provider-a:1')).toBe('provider-a:1');
    expect(() => pipe.transform(undefined)).toThrow(RequestValidationError);
    expect(() => pipe.transform('')).toThrow(RequestValidationError);
    expect(() => pipe.transform('   ')).toThrow(RequestValidationError);
    expect(() => pipe.transform('x'.repeat(256))).toThrow(RequestValidationError);
  });
});
