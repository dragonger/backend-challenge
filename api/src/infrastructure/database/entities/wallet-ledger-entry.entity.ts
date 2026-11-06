import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

/**
 * The table also has a `sequence bigint generated always as identity` column
 * used for stable cursor pagination. It is filled by the database and is
 * intentionally not mapped here (read it through the query builder).
 */
@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  properties: ['walletId', 'transactionId'],
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', length: 10 })
  direction!: LedgerDirection;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balanceBefore!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balanceAfter!: string;

  @Property({
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;
}
