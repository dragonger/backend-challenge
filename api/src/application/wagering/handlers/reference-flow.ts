import { FailureCode } from '../../../domain/errors/failure-code.js';
import { evaluateReference } from '../../../domain/wager-transaction/reference-rules.js';
import type { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.js';
import type { KindHandlerContext } from './handler.js';

/**
 * Puts the transaction in (or keeps it in) PENDING_REFERENCE. When it is a
 * re-attempt and a limit (attempts or TTL) was reached, it is rejected with
 * REFERENCE_NOT_FOUND instead.
 */
export function waitForReference(context: KindHandlerContext): void {
  const { transaction, wallet, now, policy } = context;
  const failedAttempts = transaction.isPendingReference()
    ? transaction.attempts + 1
    : 0;

  if (
    transaction.isPendingReference() &&
    policy.isExhausted(failedAttempts, transaction.createdAt, now)
  ) {
    transaction.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
    return;
  }

  transaction.markPendingReference(
    policy.nextAttemptAt(failedAttempts, now),
    wallet.balance,
  );
}

export type ReferenceStep =
  /** The handler must stop: the transaction already reached REJECTED / PENDING_REFERENCE. */
  | { settled: true }
  /** Keep going. `reference` is undefined only when none was informed. */
  | { settled: false; reference?: WagerTransaction };

/**
 * Resolves and validates the reference (when the transaction carries one).
 * Moves the transaction to REJECTED or PENDING_REFERENCE when the reference
 * does not allow the operation to proceed.
 */
export async function resolveReference(
  context: KindHandlerContext,
): Promise<ReferenceStep> {
  const { transaction, wallet, now, references } = context;

  if (transaction.referenceExternalTransactionId === undefined) {
    return { settled: false };
  }

  const reference = await references.find(transaction);

  if (!reference) {
    waitForReference(context);
    return { settled: true };
  }

  const result = evaluateReference(transaction, reference);

  switch (result.verdict) {
    case 'OK':
      return { settled: false, reference };
    case 'WAIT':
      waitForReference(context);
      return { settled: true };
    case 'REJECT':
      transaction.reject(result.code, now, wallet.balance);
      return { settled: true };
  }
}
