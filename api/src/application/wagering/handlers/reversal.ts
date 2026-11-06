import { FailureCode } from '../../../domain/errors/failure-code.js';
import { LedgerDirection } from '../../../domain/wallet/wallet-ledger-entry.js';
import type { KindHandlerContext, KindHandlerOutcome } from './handler.js';
import { resolveReference } from './reference-flow.js';

/**
 * Shared flow of REFUND and ROLLBACK (they differ only in which kinds the
 * reference rules allow, enforced by evaluateReference):
 *
 *  1. resolve the reference (missing -> PENDING_REFERENCE, invalid -> REJECTED)
 *  2. the reference was not reversed yet (one reversal in total)
 *  3. apply the inverse of the reference; a debit that would make the balance
 *     negative is REJECTED as REVERSAL_WOULD_OVERDRAW (no ledger entry)
 *
 * Runs with the wallet locked, and reversal and reference always share the
 * wallet, so step 2 cannot race with another reversal. The partial unique
 * index on wager_transactions is the last barrier.
 */
export async function applyReversal(
  context: KindHandlerContext,
): Promise<KindHandlerOutcome> {
  const step = await resolveReference(context);

  if (step.settled) {
    return {};
  }

  const { transaction, wallet, now, newId, references } = context;
  const { reference } = step;

  if (!reference) {
    // The domain guarantees a reference for REFUND/ROLLBACK.
    throw new Error(`${transaction.kind} reached the handler without reference`);
  }

  if (await references.isReversed(reference.id)) {
    transaction.reject(FailureCode.ReferenceAlreadyReversed, now, wallet.balance);
    return {};
  }

  const movement = {
    entryId: newId(),
    transactionId: transaction.id,
    money: transaction.money,
    at: now,
  };

  if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Credit) {
    const ledgerEntry = wallet.credit(movement);
    transaction.markProcessed(reference.id, now, wallet.balance);
    return { ledgerEntry };
  }

  if (!wallet.canDebit(transaction.money)) {
    transaction.reject(FailureCode.ReversalWouldOverdraw, now, wallet.balance);
    return {};
  }

  const ledgerEntry = wallet.debit(movement);
  transaction.markProcessed(reference.id, now, wallet.balance);

  return { ledgerEntry };
}
