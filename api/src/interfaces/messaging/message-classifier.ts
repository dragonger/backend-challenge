import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors.js';
import { DomainError } from '../../domain/errors/domain-error.js';
import { isTransientDatabaseError } from '../../infrastructure/database/transient-errors.js';
import { PermanentMessageError, type PermanentFailureReason } from './wager-message.js';

export type ErrorClass =
  /** Terminal business answer: nothing more to do; ack. */
  | { kind: 'business'; outcome: 'idempotency_conflict' | 'wallet_not_found' }
  /** Infrastructure hiccup: leave the message, retry later with backoff. */
  | { kind: 'transient' }
  /** Message can never succeed: DLQ with a reason. */
  | { kind: 'permanent'; reason: PermanentFailureReason; detail: string };

/**
 * Decides what to do with a failed message.
 *
 *  business   IdempotencyConflictError, WalletNotFoundError -> ack
 *  permanent  malformed / schema / unknown type / invalid command -> DLQ
 *  transient  TransientInfrastructureError, DB, network, SQS, and ANY unknown
 *             error (a bug must not drop a message; the redrive policy sends
 *             it to the DLQ once the receive limit is exhausted)
 */
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof IdempotencyConflictError) {
    return { kind: 'business', outcome: 'idempotency_conflict' };
  }

  if (error instanceof WalletNotFoundError) {
    return { kind: 'business', outcome: 'wallet_not_found' };
  }

  if (error instanceof PermanentMessageError) {
    return { kind: 'permanent', reason: error.reason, detail: error.message };
  }

  if (error instanceof TransientInfrastructureError || isTransientDatabaseError(error)) {
    return { kind: 'transient' };
  }

  if (error instanceof DomainError) {
    // Validation of the command itself (bad money, kind-specific rules, ...).
    return {
      kind: 'permanent',
      reason: 'INVALID_COMMAND',
      detail: `${error.code}: ${error.message}`,
    };
  }

  return { kind: 'transient' };
}

export interface RetryPolicy {
  baseSeconds: number;
  maxSeconds: number;
}

/**
 * Visibility timeout for the next attempt: base * 2^(receiveCount - 1), capped,
 * with +/-20% jitter so a burst of failures does not come back all at once.
 */
export function retryDelaySeconds(
  receiveCount: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(receiveCount - 1, 30));
  const raw = Math.min(policy.maxSeconds, policy.baseSeconds * 2 ** exponent);
  const jittered = raw * (0.8 + 0.4 * random());

  return Math.max(1, Math.min(policy.maxSeconds, Math.round(jittered)));
}
