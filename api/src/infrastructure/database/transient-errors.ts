import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import { TransientInfrastructureError } from '../../application/errors.js';

/**
 * SQLSTATEs that mean "try again later":
 *  55P03 lock_not_available (lock_timeout), 40001 serialization_failure,
 *  40P01 deadlock_detected, 57P01/57P02/57P03 server shutdown/startup,
 *  53300 too_many_connections, 08xxx connection exceptions.
 */
const TRANSIENT_SQLSTATES = new Set([
  '55P03',
  '40001',
  '40P01',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

const codeOf = (error: unknown): string | undefined => {
  const code = (error as ErrorLike | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
};

export function sqlStateOf(error: unknown): string | undefined {
  return codeOf(error) ?? codeOf((error as ErrorLike | undefined)?.cause);
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (
    error instanceof LockWaitTimeoutException ||
    error instanceof DeadlockException ||
    error instanceof ConnectionException
  ) {
    return true;
  }

  const state = sqlStateOf(error);

  if (
    state !== undefined &&
    (TRANSIENT_SQLSTATES.has(state) || TRANSIENT_NODE_CODES.has(state))
  ) {
    return true;
  }

  const rawMessage = (error as ErrorLike | undefined)?.message;
  const message = typeof rawMessage === 'string' ? rawMessage : '';

  return /timeout acquiring a connection|connection terminated|connection error|pool is full/i.test(
    message,
  );
}

/** Wraps transient database failures; everything else is returned untouched. */
export function toTransientIfNeeded(error: unknown): unknown {
  if (error instanceof TransientInfrastructureError) {
    return error;
  }

  if (isTransientDatabaseError(error)) {
    return new TransientInfrastructureError(
      'Temporary database failure',
      sqlStateOf(error),
      { cause: error },
    );
  }

  return error;
}
