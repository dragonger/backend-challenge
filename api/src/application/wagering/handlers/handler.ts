import type { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import type { PendingReferencePolicy } from '../pending-reference.policy.js';

/** Read access to the rows a handler needs to judge a reference. */
export interface ReferenceLookup {
  /** Finds the referenced transaction by (providerId, referenceExternalTransactionId). */
  find(transaction: WagerTransaction): Promise<WagerTransaction | null>;
  /** True when a PROCESSED REFUND/ROLLBACK already points to the transaction. */
  isReversed(referenceTransactionId: string): Promise<boolean>;
}

export interface KindHandlerContext {
  transaction: WagerTransaction;
  /** Locked (FOR UPDATE) wallet aggregate, already validated for player/currency. */
  wallet: Wallet;
  now: Date;
  newId: () => string;
  references: ReferenceLookup;
  policy: PendingReferencePolicy;
}

export interface KindHandlerOutcome {
  /** Set when the balance changed; the caller persists it with the wallet. */
  ledgerEntry?: WalletLedgerEntry;
}

/**
 * One handler per kind. A handler drives the transaction to a state (PROCESSED,
 * REJECTED or PENDING_REFERENCE) and mutates the wallet only through
 * Wallet.debit/credit, so persistence stays in the use case.
 *
 * The same handler runs for a brand new transaction (status PENDING) and for
 * a re-attempt of a PENDING_REFERENCE one.
 */
export interface KindHandler {
  handle(context: KindHandlerContext): Promise<KindHandlerOutcome>;
}
