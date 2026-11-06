import { FailureCode } from '../errors/failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

/**
 * Result of checking a transaction against the transaction it references.
 *  - OK: the reference is valid, the kind handler can apply the rule.
 *  - WAIT: the reference is not resolved yet (PENDING / PENDING_REFERENCE),
 *    the new transaction must wait as PENDING_REFERENCE.
 *  - REJECT: definitive business rejection with a stable failure code.
 */
export type ReferenceVerdict =
  | { verdict: 'OK' }
  | { verdict: 'WAIT' }
  | { verdict: 'REJECT'; code: FailureCode };

const BET_ONLY: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
]);

/**
 * Kinds each operation may reference. BET has no reference. A reversal of a
 * reversal (ROLLBACK of ROLLBACK), of a LOSS (no balance effect) or of an
 * OPENING (internal credit) is forbidden.
 */
const ALLOWED_REFERENCE_KINDS: Readonly<
  Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>
> = {
  [WagerTransactionKind.Opening]: new Set(),
  [WagerTransactionKind.Bet]: new Set(),
  [WagerTransactionKind.Win]: BET_ONLY,
  [WagerTransactionKind.Loss]: BET_ONLY,
  [WagerTransactionKind.Refund]: BET_ONLY,
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

/**
 * Pure rule: can `transaction` be applied on top of `reference`?
 *
 * Order matters (definitive answers first, waiting last):
 *  1. same provider, player, wallet, currency and round -> REFERENCE_MISMATCH
 *  2. allowed kind for this operation                    -> INVALID_REFERENCE_KIND
 *  3. reference still unresolved                         -> WAIT
 *  4. reference REJECTED / FAILED                        -> REFERENCE_NOT_PROCESSED
 *  5. reversals only: same amount                        -> AMOUNT_MISMATCH
 *
 * "Already reversed" depends on other rows and is checked by the handler.
 */
export function evaluateReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): ReferenceVerdict {
  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.money.currency !== transaction.money.currency ||
    reference.roundId !== transaction.roundId
  ) {
    return { verdict: 'REJECT', code: FailureCode.ReferenceMismatch };
  }

  if (!ALLOWED_REFERENCE_KINDS[transaction.kind].has(reference.kind)) {
    return { verdict: 'REJECT', code: FailureCode.InvalidReferenceKind };
  }

  switch (reference.status) {
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return { verdict: 'WAIT' };
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return { verdict: 'REJECT', code: FailureCode.ReferenceNotProcessed };
    case WagerTransactionStatus.Processed:
      break;
  }

  if (transaction.requiresReference() && !transaction.money.equals(reference.money)) {
    return { verdict: 'REJECT', code: FailureCode.AmountMismatch };
  }

  return { verdict: 'OK' };
}
