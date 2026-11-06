import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';

import { InvalidWalletError } from '../../domain/errors/domain-error.js';
import { Money } from '../../domain/money/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wager-transaction/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { OutboxMessageEntity } from '../../infrastructure/database/entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity.js';
import { WalletLedgerEntryEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { LedgerEntryMapper } from '../../infrastructure/database/mappers/ledger-entry.mapper.js';
import { OutboxMapper } from '../../infrastructure/database/mappers/outbox.mapper.js';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper.js';
import { WalletMapper } from '../../infrastructure/database/mappers/wallet.mapper.js';
import { TransactionRunner } from '../../infrastructure/database/transaction-runner.js';
import { isUniqueViolation } from '../../infrastructure/database/unique-violation.js';
import { WalletAlreadyExistsError } from '../errors.js';
import type { EventContext } from '../events/integration-event.js';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../events/wager-events.js';
import { computePayloadHash } from '../idempotency/payload-hash.js';
import type { OpenWalletCommand, OpenWalletResult } from '../wagering/commands.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Creates the wallet. A positive initial balance produces, in the same SQL
 * transaction, an OPENING transaction (PROCESSED), a CREDIT ledger entry and
 * the integration events in the outbox.
 */
@Injectable()
export class OpenWallet {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    if (typeof command.playerId !== 'string' || !UUID_PATTERN.test(command.playerId)) {
      throw new InvalidWalletError('playerId must be a UUID');
    }

    if (command.walletId !== undefined && !UUID_PATTERN.test(command.walletId)) {
      throw new InvalidWalletError('walletId must be a UUID');
    }

    const initialBalance = Money.from(command.initialBalance);
    const currency = initialBalance.currency;

    try {
      return await this.runner.run((em) =>
        this.open(em, command, initialBalance),
      );
    } catch (error) {
      // UNIQUE (player_id, currency) is the source of truth under races.
      if (isUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(command.playerId, currency);
      }

      throw error;
    }
  }

  private async open(
    em: EntityManager,
    command: OpenWalletCommand,
    initialBalance: Money,
  ): Promise<OpenWalletResult> {
    const currency = initialBalance.currency;
    const now = new Date();

    const existing = await em.findOne(WalletEntity, {
      playerId: command.playerId,
      currency,
    });

    if (existing) {
      throw new WalletAlreadyExistsError(command.playerId, currency);
    }

    const wallet = Wallet.open({
      id: command.walletId ?? randomUUID(),
      playerId: command.playerId,
      initialBalance,
      now,
    });

    em.create(WalletEntity, WalletMapper.toEntityData(wallet));
    await em.flush();

    if (initialBalance.isPositive()) {
      await this.recordOpeningCredit(em, wallet, initialBalance, now, command);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private async recordOpeningCredit(
    em: EntityManager,
    wallet: Wallet,
    initialBalance: Money,
    now: Date,
    command: OpenWalletCommand,
  ): Promise<void> {
    const externalId = `opening:${wallet.id}`;
    const money = initialBalance.toJSON();

    const transaction = WagerTransaction.createOpening({
      id: randomUUID(),
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: externalId,
      payloadHash: computePayloadHash({
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money,
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      createdAt: now,
    });

    transaction.markProcessed(undefined, now, wallet.balance);

    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    em.create(
      WagerTransactionEntity,
      WagerTransactionMapper.toEntityData(transaction),
    );
    await em.flush();

    em.create(WalletLedgerEntryEntity, LedgerEntryMapper.toEntityData(entry));

    const base: EventContext = {
      eventId: '',
      correlationId: command.correlationId ?? randomUUID(),
      occurredAt: now,
    };

    for (const event of [
      WagerTransactionProcessed.from(transaction, { ...base, eventId: randomUUID() }),
      WalletBalanceChanged.from(wallet, entry, { ...base, eventId: randomUUID() }),
    ]) {
      em.create(OutboxMessageEntity, OutboxMapper.toEntityData(event, now));
    }

    await em.flush();
  }
}
