import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';

import { FailureCode } from '../../domain/errors/failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper.js';
import type { EventContext, IntegrationEvent } from '../events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events/wager-events.js';
import type { KindHandlerContext, ReferenceLookup } from './handlers/handler.js';
import { createKindHandlers, type KindHandlers } from './kind-handlers.js';
import { PendingReferencePolicy } from './pending-reference.policy.js';

/** Reads references inside the caller's SQL transaction (wallet already locked). */
export class SqlReferenceLookup implements ReferenceLookup {
  constructor(private readonly em: EntityManager) {}

  async find(transaction: WagerTransaction): Promise<WagerTransaction | null> {
    if (transaction.referenceExternalTransactionId === undefined) {
      return null;
    }

    const row = await this.em.findOne(WagerTransactionEntity, {
      providerId: transaction.providerId,
      externalTransactionId: transaction.referenceExternalTransactionId,
    });

    return row ? WagerTransactionMapper.toDomain(row) : null;
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `select id from wager_transactions
        where reference_transaction_id = ?
          and status = 'PROCESSED'
          and kind in ('REFUND', 'ROLLBACK')
        limit 1`,
      [referenceTransactionId],
    );

    return rows.length > 0;
  }
}

/**
 * The business rules shared by the submit path (new transaction) and the
 * resolve path (re-attempt of a PENDING_REFERENCE one). It only mutates the
 * in-memory aggregates; persisting them is up to the caller.
 */
export class WagerRules {
  private readonly handlers: KindHandlers = createKindHandlers();

  constructor(private readonly policy: PendingReferencePolicy) {}

  /**
   * Drives `transaction` to PROCESSED, REJECTED or PENDING_REFERENCE.
   * Returns the ledger entry when the balance changed.
   */
  async apply(
    em: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    if (wallet.playerId !== transaction.playerId) {
      transaction.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
      return undefined;
    }

    if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      return undefined;
    }

    if (transaction.kind === WagerTransactionKind.Opening) {
      throw new Error('OPENING is internal and has no handler');
    }

    const context: KindHandlerContext = {
      transaction,
      wallet,
      now,
      newId: randomUUID,
      references: new SqlReferenceLookup(em),
      policy: this.policy,
    };

    const outcome = await this.handlers[transaction.kind].handle(context);

    return outcome.ledgerEntry;
  }

  /**
   * Integration events of the state the transaction just reached.
   * `announcePending` is false when a pending transaction stays pending after
   * a re-attempt (the PendingReference event was already emitted).
   */
  eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | undefined,
    base: EventContext,
    announcePending = true,
  ): Array<IntegrationEvent<unknown>> {
    const ctx = (): EventContext => ({ ...base, eventId: randomUUID() });
    const events: Array<IntegrationEvent<unknown>> = [];

    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        events.push(WagerTransactionProcessed.from(transaction, ctx()));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(transaction, ctx()));
        break;
      case WagerTransactionStatus.PendingReference:
        if (announcePending) {
          events.push(WagerTransactionPendingReference.from(transaction, ctx()));
        }
        break;
      default:
        break;
    }

    if (ledgerEntry) {
      events.push(WalletBalanceChanged.from(wallet, ledgerEntry, ctx()));
    }

    return events;
  }
}
