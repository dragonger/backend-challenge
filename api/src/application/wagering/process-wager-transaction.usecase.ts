import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import { InvalidWagerTransactionError } from '../../domain/errors/domain-error.js';
import { Money } from '../../domain/money/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wager-transaction/wager-transaction.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity.js';
import { WalletLedgerEntryEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../infrastructure/database/entities/outbox-message.entity.js';
import { LedgerEntryMapper } from '../../infrastructure/database/mappers/ledger-entry.mapper.js';
import { OutboxMapper } from '../../infrastructure/database/mappers/outbox.mapper.js';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper.js';
import { WalletMapper } from '../../infrastructure/database/mappers/wallet.mapper.js';
import { TransactionRunner } from '../../infrastructure/database/transaction-runner.js';
import { MetricsService, type Channel } from '../../infrastructure/metrics/metrics.service.js';
import { bindContext, currentContext } from '../../infrastructure/observability/request-context.js';
import { isUniqueViolation } from '../../infrastructure/database/unique-violation.js';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../errors.js';
import type { EventContext } from '../events/integration-event.js';
import { computePayloadHash } from '../idempotency/payload-hash.js';
import type {
  InboxContext,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from './commands.js';
import {
  DEFAULT_PENDING_REFERENCE_CONFIG,
  PENDING_REFERENCE_CONFIG,
  PendingReferencePolicy,
  type PendingReferenceConfig,
} from './pending-reference.policy.js';
import { WagerRules } from './wager-rules.js';

const MAX_UNIQUE_VIOLATION_RETRIES = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

interface ValidatedInput {
  command: ProcessWagerTransactionCommand;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: Money;
  payloadHash: string;
  correlationId: string;
}

/**
 * Single entry point for HTTP and SQS. Everything below happens in ONE SQL
 * transaction: (inbox) -> idempotency -> wallet lock -> rule -> transaction
 * row, ledger, balance and outbox rows.
 */
@Injectable()
export class ProcessWagerTransaction {
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
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const input = this.validate(command);
    const channel: Channel = command.inbox ? 'sqs' : 'http';
    const stopTimer = this.metrics?.processingDuration.startTimer({ channel });

    bindContext({
      correlationId: input.correlationId,
      providerId: command.providerId,
      walletId: command.walletId,
      ...(command.inbox ? { messageId: command.inbox.messageId } : {}),
    });

    try {
      const result = await this.executeWithRetry(input);

      bindContext({ transactionId: result.transactionId });
      this.record(result, input.kind, channel);

      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        this.metrics?.idempotencyConflicts.inc();
      }

      throw error;
    } finally {
      stopTimer?.();
    }
  }

  private record(
    result: ProcessWagerTransactionResult,
    kind: string,
    channel: Channel,
  ): void {
    if (result.idempotentReplay) {
      this.metrics?.idempotentReplays.inc({ channel });
    } else {
      this.metrics?.wagerTransactions.inc({ kind, status: result.status, channel });
    }
  }

  private async executeWithRetry(
    input: ValidatedInput,
  ): Promise<ProcessWagerTransactionResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.runner.run((em) => this.process(em, input));
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }

        // A concurrent transaction committed the same idempotency identity
        // after our lookup. The failed transaction was rolled back: run again
        // from scratch so the lookup now sees the winner (replay or conflict).
        if (attempt >= MAX_UNIQUE_VIOLATION_RETRIES) {
          throw new TransientInfrastructureError(
            'Unique violation did not settle',
            '23505',
            { cause: error },
          );
        }
      }
    }
  }

  /**
   * Test seam: runs after every row is written and before the SQL commit.
   * Throwing here must leave nothing behind.
   */
  protected beforeCommit(_em: EntityManager): Promise<void> {
    return Promise.resolve();
  }

  private async process(
    em: EntityManager,
    input: ValidatedInput,
  ): Promise<ProcessWagerTransactionResult> {
    const { command } = input;
    const now = new Date();

    if (command.inbox) {
      const inserted = await this.insertInbox(em, command.inbox, now);

      if (!inserted) {
        return this.resolveInboxDuplicate(em, input, command.inbox);
      }
    }

    // Cheap path: already known, no lock needed.
    const known = await this.findExisting(em, input);

    if (known) {
      return this.toReplay(em, known);
    }

    const walletEntity = await em.findOne(
      WalletEntity,
      { id: command.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (!walletEntity) {
      throw new WalletNotFoundError(command.walletId);
    }

    // The same operation may have been committed while we waited for the lock.
    const knownAfterLock = await this.findExisting(em, input);

    if (knownAfterLock) {
      return this.toReplay(em, knownAfterLock);
    }

    const wallet = WalletMapper.toDomain(walletEntity);
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: wallet.id,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const ledgerEntry = await this.rules.apply(em, transaction, wallet, now);

    // 1st flush: wallet balance + transaction row (ledger has an FK to it).
    em.create(
      WagerTransactionEntity,
      WagerTransactionMapper.toEntityData(transaction),
    );

    if (ledgerEntry) {
      WalletMapper.applyToEntity(wallet, walletEntity);
    }

    await em.flush();

    // 2nd flush: ledger entry + outbox rows.
    if (ledgerEntry) {
      em.create(
        WalletLedgerEntryEntity,
        LedgerEntryMapper.toEntityData(ledgerEntry),
      );
    }

    const context: EventContext = {
      eventId: '',
      correlationId: input.correlationId,
      causationId: command.causationId ?? command.inbox?.messageId,
      occurredAt: now,
    };

    for (const event of this.rules.eventsFor(
      transaction,
      wallet,
      ledgerEntry,
      context,
    )) {
      em.create(OutboxMessageEntity, OutboxMapper.toEntityData(event, now));
    }

    if (command.inbox) {
      await em.execute(
        `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
        [now, command.inbox.consumerName, command.inbox.messageId],
      );
    }

    await em.flush();
    await this.beforeCommit(em);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: (transaction.balanceAfter ?? wallet.balance).toJSON(),
      idempotentReplay: false,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    };
  }

  /**
   * Finds a previous execution by idempotency key and by provider identity.
   * Returns the transaction for a legitimate replay, null when it is new and
   * throws IdempotencyConflictError for any inconsistent reuse.
   */
  private async findExisting(
    em: EntityManager,
    input: ValidatedInput,
  ): Promise<WagerTransaction | null> {
    const { command, payloadHash } = input;

    // One statement = one snapshot. Two separate lookups could straddle the
    // commit of a concurrent transaction and see only half of its identity.
    const rows = await em.find(WagerTransactionEntity, {
      $or: [
        { idempotencyKey: command.idempotencyKey },
        {
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
        },
      ],
    });
    const byKey = rows.find((r) => r.idempotencyKey === command.idempotencyKey);
    const byExternal = rows.find(
      (r) =>
        r.providerId === command.providerId &&
        r.externalTransactionId === command.externalTransactionId,
    );

    if (!byKey && !byExternal) {
      return null;
    }

    if (byKey && byExternal && byKey.id !== byExternal.id) {
      throw new IdempotencyConflictError(
        'Idempotency key and provider transaction id point to different transactions',
      );
    }

    if (!byKey) {
      throw new IdempotencyConflictError(
        'Provider transaction id already used with a different idempotency key',
      );
    }

    const existing = WagerTransactionMapper.toDomain(byKey);

    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        'Idempotency key already used with a different payload',
      );
    }

    return existing;
  }

  /**
   * Replay answers with the result committed the first time. A transaction
   * still waiting for its reference (PENDING_REFERENCE) has no final result
   * yet, so the replay reports the same status and the CURRENT wallet balance
   * (the snapshot of a pending row is only the balance seen at the last attempt).
   */
  private async toReplay(
    em: EntityManager,
    transaction: WagerTransaction,
  ): Promise<ProcessWagerTransactionResult> {
    if (transaction.isPendingReference()) {
      const rows = await em.execute<Array<{ balance: string }>>(
        `select balance::text as balance from wallets where id = ?`,
        [transaction.walletId],
      );

      if (!rows[0]) {
        throw new WalletNotFoundError(transaction.walletId);
      }

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: { amount: rows[0].balance, currency: transaction.money.currency },
        idempotentReplay: true,
      };
    }

    if (!transaction.balanceAfter) {
      throw new Error(
        `Transaction ${transaction.id} has no balance snapshot to replay`,
      );
    }

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.balanceAfter.toJSON(),
      idempotentReplay: true,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    };
  }

  /** Inserts the inbox row; false when the message was already received. */
  private async insertInbox(
    em: EntityManager,
    inbox: InboxContext,
    now: Date,
  ): Promise<boolean> {
    const rows = await em.execute<Array<{ message_id: string }>>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [inbox.consumerName, inbox.messageId, inbox.payloadHash, now],
    );

    return rows.length > 0;
  }

  /** Redelivery: no side effects, return the result that was committed. */
  private async resolveInboxDuplicate(
    em: EntityManager,
    input: ValidatedInput,
    inbox: InboxContext,
  ): Promise<ProcessWagerTransactionResult> {
    const rows = await em.execute<Array<{ payload_hash: string }>>(
      `select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
      [inbox.consumerName, inbox.messageId],
    );

    if (rows[0] && rows[0].payload_hash !== inbox.payloadHash) {
      throw new IdempotencyConflictError(
        'Inbox message id already received with a different payload',
      );
    }

    const known = await this.findExisting(em, input);

    if (!known) {
      throw new Error(
        `Inbox message ${inbox.messageId} was received but has no transaction`,
      );
    }

    return this.toReplay(em, known);
  }

  private validate(command: ProcessWagerTransactionCommand): ValidatedInput {
    const text = (name: string, value: unknown, max: number): string => {
      if (typeof value !== 'string' || !value.trim()) {
        throw new InvalidWagerTransactionError(`${name} is required`);
      }

      if (value.length > max) {
        throw new InvalidWagerTransactionError(
          `${name} must have at most ${max} characters`,
        );
      }

      return value;
    };

    text('providerId', command.providerId, 100);
    text('externalTransactionId', command.externalTransactionId, 150);
    text('idempotencyKey', command.idempotencyKey, 255);
    text('roundId', command.roundId, 150);
    text('gameId', command.gameId, 150);

    for (const [name, value] of [
      ['playerId', command.playerId],
      ['walletId', command.walletId],
    ] as const) {
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new InvalidWagerTransactionError(`${name} must be a UUID`);
      }
    }

    if (!SUBMITTABLE_KINDS.has(command.kind)) {
      throw new InvalidWagerTransactionError(
        `kind ${String(command.kind)} cannot be submitted`,
      );
    }

    if (command.referenceExternalTransactionId !== undefined) {
      text(
        'referenceExternalTransactionId',
        command.referenceExternalTransactionId,
        150,
      );
    }

    if (command.inbox) {
      text('inbox.consumerName', command.inbox.consumerName, 100);
      text('inbox.messageId', command.inbox.messageId, 255);
      text('inbox.payloadHash', command.inbox.payloadHash, 64);
    }

    const money = Money.from(command.money);
    const kind = command.kind as ValidatedInput['kind'];

    // Fails fast on kind-specific rules (reference required, amount > 0, ...).
    WagerTransaction.create({
      id: 'validation',
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: 'validation',
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    return {
      command,
      kind,
      money,
      correlationId:
        command.correlationId ?? currentContext()?.correlationId ?? randomUUID(),
      payloadHash: computePayloadHash({
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind,
        money: money.toJSON(),
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      }),
    };
  }
}
