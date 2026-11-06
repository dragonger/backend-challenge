import { describe, expect, test } from 'bun:test';

import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors.js';
import { InvalidMoneyError } from '../../domain/errors/domain-error.js';
import { classifyError, retryDelaySeconds } from './message-classifier.js';
import { parseWagerMessage, PermanentMessageError } from './wager-message.js';

const valid = {
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    idempotencyKey: 'provider-a:tx-1',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

describe('classifyError', () => {
  test('business results are acked', () => {
    expect(classifyError(new IdempotencyConflictError('x')).kind).toBe('business');
    expect(classifyError(new WalletNotFoundError('w')).kind).toBe('business');
  });

  test('infrastructure and unknown errors are transient', () => {
    expect(classifyError(new TransientInfrastructureError('lock', '55P03')).kind).toBe('transient');
    expect(
      classifyError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).kind,
    ).toBe('transient');
    expect(classifyError(new Error('bug')).kind).toBe('transient');
  });

  test('malformed messages and invalid commands are permanent', () => {
    expect(classifyError(new PermanentMessageError('MALFORMED_JSON', 'x'))).toMatchObject({
      kind: 'permanent',
      reason: 'MALFORMED_JSON',
    });
    expect(classifyError(new InvalidMoneyError('bad'))).toMatchObject({
      kind: 'permanent',
      reason: 'INVALID_COMMAND',
    });
  });
});

describe('retryDelaySeconds', () => {
  const policy = { baseSeconds: 2, maxSeconds: 60 };
  const mid = () => 0.5;

  test('grows exponentially and is capped', () => {
    expect(retryDelaySeconds(1, policy, mid)).toBe(2);
    expect(retryDelaySeconds(2, policy, mid)).toBe(4);
    expect(retryDelaySeconds(3, policy, mid)).toBe(8);
    expect(retryDelaySeconds(10, policy, mid)).toBe(60);
    expect(retryDelaySeconds(1000, policy, mid)).toBe(60);
  });

  test('jitter stays within 20 percent', () => {
    expect(retryDelaySeconds(4, policy, () => 0)).toBe(Math.round(16 * 0.8));
    expect(retryDelaySeconds(4, policy, () => 1)).toBe(Math.round(16 * 1.2));
  });
});

describe('parseWagerMessage', () => {
  const reasonOf = (body: string): string | undefined => {
    try {
      parseWagerMessage(body);
      return undefined;
    } catch (error) {
      return (error as PermanentMessageError).reason;
    }
  };

  test('accepts the README message and hashes the canonical body', () => {
    const a = parseWagerMessage(JSON.stringify(valid));
    const reordered = {
      data: valid.data,
      occurredAt: valid.occurredAt,
      type: valid.type,
      messageId: valid.messageId,
    };
    const b = parseWagerMessage(JSON.stringify(reordered));

    expect(a.message.messageId).toBe('msg-1');
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.payloadHash).toBe(a.payloadHash);
  });

  test('rejects malformed bodies with a stable reason', () => {
    expect(reasonOf('not json')).toBe('MALFORMED_JSON');
    expect(reasonOf('[1]')).toBe('MALFORMED_JSON');
    expect(reasonOf(JSON.stringify({ ...valid, type: 'Other' }))).toBe('UNKNOWN_MESSAGE_TYPE');
    expect(reasonOf(JSON.stringify({ ...valid, data: { ...valid.data, kind: 'OPENING' } }))).toBe(
      'INVALID_SCHEMA',
    );
    expect(
      reasonOf(
        JSON.stringify({ ...valid, data: { ...valid.data, money: { amount: 25, currency: 'BRL' } } }),
      ),
    ).toBe('INVALID_SCHEMA');
    expect(reasonOf(JSON.stringify({ ...valid, occurredAt: 'yesterday' }))).toBe('INVALID_SCHEMA');
  });
});
