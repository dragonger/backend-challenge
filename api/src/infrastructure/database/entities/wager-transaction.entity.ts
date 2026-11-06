
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

export {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.js';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  properties: ['idempotencyKey'],
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 100 })
  providerId!: string;

  @Property({ type: 'string', length: 150 })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', length: 150 })
  roundId!: string;

  @Property({ type: 'string', length: 150 })
  gameId!: string;

  @Property({ type: 'string', length: 20 })
  kind!: WagerTransactionKind;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', length: 30 })
  status: WagerTransactionStatus =
    WagerTransactionStatus.Pending;

  @Property({ type: 'string', length: 150, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ type: 'string', length: 100, nullable: true })
  failureCode?: string;

  @Property({
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;

  /** Snapshot: balance observed when the transaction was resolved (replay). */
  @Property({ type: 'decimal', precision: 20, scale: 2, nullable: true })
  balanceAfter?: string;

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0;

  @Property({ columnType: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;
}
