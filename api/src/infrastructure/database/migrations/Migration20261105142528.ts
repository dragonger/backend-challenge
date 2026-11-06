
import { Migration } from '@mikro-orm/migrations';

export class Migration20261105142528 extends Migration {
  override name = 'Migration20261105142528';

  override up(): void | Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(20,2) not null,
        primary key ("id"),
        constraint "wallets_balance_non_negative"
          check ("balance" >= 0)
      );
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets";`);
  }
}
