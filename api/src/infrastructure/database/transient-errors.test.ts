import { describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../application/errors.js';
import { isTransientDatabaseError, toTransientIfNeeded } from './transient-errors.js';
import { isUniqueViolation } from './unique-violation.js';

describe('transient database errors', () => {
  test.each(['55P03', '40001', '40P01', '57P01', '08006', 'ECONNRESET'])(
    'SQLSTATE / code %s is transient',
    (code) => {
      const error = Object.assign(new Error('boom'), { code });

      expect(isTransientDatabaseError(error)).toBe(true);

      const wrapped = toTransientIfNeeded(error);
      expect(wrapped).toBeInstanceOf(TransientInfrastructureError);
      expect((wrapped as TransientInfrastructureError).sqlState).toBe(code);
    },
  );

  test('the code can sit in the cause chain', () => {
    const error = new Error('wrapped', { cause: { code: '40P01' } });

    expect(isTransientDatabaseError(error)).toBe(true);
  });

  test.each(['23505', '23514', '23503', '42P01'])(
    'SQLSTATE %s is not transient and passes through untouched',
    (code) => {
      const error = Object.assign(new Error('permanent'), { code });

      expect(isTransientDatabaseError(error)).toBe(false);
      expect(toTransientIfNeeded(error)).toBe(error);
    },
  );

  test('detects unique violations by SQLSTATE', () => {
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: '23505' }))).toBe(true);
    expect(isUniqueViolation(new Error('x', { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
  });
});
