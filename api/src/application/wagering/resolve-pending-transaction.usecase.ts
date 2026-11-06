import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { FailureCode } from '../../domain/errors/failure-code.js';
import type { MoneyProps } from '../../domain/money/money.js';
import {
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.js';
import { OutboxMessageEntity } from '../../infrastructure/database/entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity.js';
import { WalletLedgerEntryEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { LedgerEntryMapper } from '../../infrastructure/database/mappers/ledger-entry.mapper.js';
import { OutboxMapper } from '../../infrastructure/database/mappers/outbox.mapper.js';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper.js';
import { WalletMapper } from '../../infrastructure/database/mappers/wallet.mapper.js';
import { TransactionRunner } from '../../infrastructure/database/transaction-runner.js';
import { MetricsService } from '../../infrastructure/metrics/metrics.service.js';
import { bindContext } from '../../infrastructure/observability/request-context.js';
import type { EventContext } from '../events/integration-event.js';
import {
  DEFAULT_PENDING_REFERENCE_CONFIG,
  PENDING_REFERENCE_CONFIG,
  PendingReferencePolicy,
  type PendingReferenceConfig,
} from './pending-reference.policy.js';
import { WagerRules } from './wager-rules.js';

export enum ResolvePendingOutcome {
  /** No transaction with that id. */
  NotFound = 'NOT_FOUND',
  /** Already resolved by someone else (or never pending): nothing done. */
  NotPending = 'NOT_PENDING',
  /** Reference still missing; attempts incremented and retry rescheduled. */
  Rescheduled = 'RESCHEDULED',
  Processed = 'PROCESSED',
  /** Includes the exhaustion case (REFERENCE_NOT_FOUND). */
  Rejected = 'REJECTED',
}

export interface ResolvePendingResult {
  transactionId: string;
  outcome: ResolvePendingOutcome;
  status?: WagerTransactionStatus;
  failureCode?: FailureCode;
  kind?: string;
  attempts?: number;
  balance?: MoneyProps;
}

export interface ResolvePendingOptions {
  /** Injectable clock, mostly for tests. */
  now?: Date;
}

/**
 * Re-attempts ONE PENDING_REFERENCE transaction in a single SQL transaction:
 * lock the wallet, resolve the reference again and either
 *  - apply the rule (PROCESSED / REJECTED with ledger, balance, snapshot and
 *    events), or
 *  - keep waiting (attempts + 1, next attempt rescheduled with backoff), or
 *  - give up when the attempt or TTL limit was reached
 *    (REJECTED REFERENCE_NOT_FOUND + WagerTransactionRejected event).
 *
 * Safe to call concurrently for the same id: the wallet lock serializes the
 * callers and the loser finds the transaction already resolved (NOT_PENDING).
 * The scheduling loop that calls this belongs to Stage 3.
 */
@Injectable()
export class ResolvePendingTransaction {
  private readonly rules: WagerRules;

  constructor(
    private readonly runner: TransactionRunner,
    @Optional()
    @Inject(PENDING_REFERENCE_CONFIG)
    pendingConfig: PendingReferenceConfig = DEFAULT_PENDING_REFERENCE_CONFIG,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.rules = new WagerRules(new PendingReferencePolicy(pendingConfig));
  }

  async execute(
    transactionId: string,
    options: ResolvePendingOptions = {},
  ): Promise<ResolvePendingResult> {
    bindContext({ transactionId });

    const result = await this.runner.run((em) =>
      this.resolve(em, transactionId, options.now ?? new Date()),
    );

    if (
      this.metrics &&
      result.status &&
      (result.outcome === ResolvePendingOutcome.Processed ||
        result.outcome === ResolvePendingOutcome.Rejected)
    ) {
      // The kind is not part of the result; the final status is what matters here.
      this.metrics.wagerTransactions.inc({
        kind: result.kind ?? 'UNKNOWN',
        status: result.status,
        channel: 'worker',
      });
    }

    return result;
  }

  private async resolve(
    em: EntityManager,
    transactionId: string,
    now: Date,
  ): Promise<ResolvePendingResult> {
    // Plain read (no entity yet) just to learn which wallet to lock. The row
    // itself is loaded AFTER the lock, so we never act on a stale state.
    const peek = await em.execute<Array<{ wallet_id: string; status: string }>>(
      `select wallet_id, status from wager_transactions where id = ?`,
      [transactionId],
    );

    if (!peek[0]) {
      return { transactionId, outcome: ResolvePendingOutcome.NotFound };
    }

    if (peek[0].status !== WagerTransactionStatus.PendingReference) {
      return { transactionId, outcome: ResolvePendingOutcome.NotPending };
    }

    bindContext({ walletId: peek[0].wallet_id });

    const walletEntity = await em.findOneOrFail(
      WalletEntity,
      { id: peek[0].wallet_id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    const entity = await em.findOneOrFail(WagerTransactionEntity, {
      id: transactionId,
    });

    if (entity.status !== WagerTransactionStatus.PendingReference) {
      return { transactionId, outcome: ResolvePendingOutcome.NotPending };
    }

    const wallet = WalletMapper.toDomain(walletEntity);
    const transaction = WagerTransactionMapper.toDomain(entity);

    const ledgerEntry = await this.rules.apply(em, transaction, wallet, now);

    WagerTransactionMapper.applyToEntity(transaction, entity);

    if (ledgerEntry) {
      WalletMapper.applyToEntity(wallet, walletEntity);
    }

    await em.flush();

    if (ledgerEntry) {
      em.create(
        WalletLedgerEntryEntity,
        LedgerEntryMapper.toEntityData(ledgerEntry),
      );
    }

    const context: EventContext = {
      eventId: '',
      correlationId: randomUUID(),
      causationId: transaction.id,
      occurredAt: now,
    };

    for (const event of this.rules.eventsFor(
      transaction,
      wallet,
      ledgerEntry,
      context,
      false,
    )) {
      em.create(OutboxMessageEntity, OutboxMapper.toEntityData(event, now));
    }

    await em.flush();

    return {
      transactionId,
      outcome: outcomeOf(transaction.status),
      status: transaction.status,
      kind: transaction.kind,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      attempts: transaction.attempts,
      balance: (transaction.balanceAfter ?? wallet.balance).toJSON(),
    };
  }
}

function outcomeOf(status: WagerTransactionStatus): ResolvePendingOutcome {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return ResolvePendingOutcome.Processed;
    case WagerTransactionStatus.Rejected:
      return ResolvePendingOutcome.Rejected;
    default:
      return ResolvePendingOutcome.Rescheduled;
  }
}
