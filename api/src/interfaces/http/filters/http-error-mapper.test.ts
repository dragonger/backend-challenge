import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  IdempotencyConflictError,
  InvalidCursorError,
  TransientInfrastructureError,
  WagerTransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../application/errors.js';
import {
  InvalidMoneyError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../domain/errors/domain-error.js';
import { RequestValidationError } from '../validation/zod.pipe.js';
import { mapExceptionToHttp } from './http-error-mapper.js';

describe('mapExceptionToHttp', () => {
  test.each([
    ['validation', new RequestValidationError([{ path: 'a', message: 'bad' }]), 400, 'VALIDATION_ERROR'],
    ['cursor', new InvalidCursorError(), 400, 'INVALID_CURSOR'],
    ['domain money', new InvalidMoneyError('Invalid monetary amount'), 400, 'INVALID_MONEY'],
    ['domain transaction', new InvalidWagerTransactionError('x'), 400, 'INVALID_WAGER_TRANSACTION'],
    ['idempotency', new IdempotencyConflictError('x'), 409, 'IDEMPOTENCY_CONFLICT'],
    ['duplicate wallet', new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS'],
    ['wallet 404', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    ['transaction 404', new WagerTransactionNotFoundError('t'), 404, 'TRANSACTION_NOT_FOUND'],
    ['transient', new TransientInfrastructureError('x', '55P03'), 503, 'TRANSIENT_INFRASTRUCTURE'],
    ['nest 404', new NotFoundException(), 404, 'NOT_FOUND'],
    ['nest 400', new BadRequestException(), 400, 'BAD_REQUEST'],
  ] as const)('%s', (_name, error, status, code) => {
    const mapped = mapExceptionToHttp(error);

    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.unexpected).toBeUndefined();
  });

  test('503 carries Retry-After', () => {
    expect(mapExceptionToHttp(new TransientInfrastructureError('x')).retryAfterSeconds).toBe(1);
  });

  test('raw connection errors become 503', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(mapExceptionToHttp(error).status).toBe(503);
  });

  test('body-parser invalid JSON becomes 400', () => {
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    const mapped = mapExceptionToHttp(error);

    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe('INVALID_JSON');
  });

  test('programming and unknown errors are a generic 500 without internal details', () => {
    for (const error of [
      new InvalidTransactionStateError('PROCESSED', 'REJECTED'),
      new Error('secret internal detail'),
      'string error',
    ]) {
      const mapped = mapExceptionToHttp(error);

      expect(mapped.status).toBe(500);
      expect(mapped.unexpected).toBe(true);
      expect(JSON.stringify(mapped.body)).not.toContain('secret');
    }
  });
});
