
import { Migration } from '@mikro-orm/migrations';

export class Migration20261105154420 extends Migration {
  override name = 'Migration20261105154420';

  override up(): void | Promise<void> {
    this.addSql(`
      alter table "wallets"
        add "player_id" uuid not null,
        add "version" int not null default 1,
        add "created_at" timestamptz not null default now(),
        add "updated_at" timestamptz not null default now();
    `);

    this.addSql(`
      alter table "wallets"
        add constraint "wallets_player_id_currency_unique"
        unique ("player_id", "currency");
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      alter table "wallets"
        drop constraint "wallets_player_id_currency_unique";
    `);

    this.addSql(`
      alter table "wallets"
        drop column "player_id",
        drop column "version",
        drop column "created_at",
        drop column "updated_at";
    `);
  }
}
