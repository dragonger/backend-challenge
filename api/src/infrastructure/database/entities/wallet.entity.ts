import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Check,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
@Check({
  name: 'wallets_balance_non_negative',
  expression: 'balance >= 0',
})
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balance!: string;

  @Property({ type: 'integer', default: 1 })
  version: number = 1;

  @Property({
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    columnType: 'timestamptz',
    defaultRaw: 'now()',
  })
  updatedAt!: Date;
}
