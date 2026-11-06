
import { Migration } from '@mikro-orm/migrations';

export class Migration20261105160746 extends Migration {
  override name = 'Migration20261105160746';

  override up(): void {
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(100) not null,
        "external_transaction_id" varchar(150) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" varchar(64) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(150) not null,
        "game_id" varchar(150) not null,
        "kind" varchar(20) not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "status" varchar(30) not null default 'PENDING',
        "reference_external_transaction_id" varchar(150),
        "reference_transaction_id" uuid,
        "failure_code" varchar(100),
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_idempotency_key_unique"
          unique ("idempotency_key"),
        constraint "wager_transactions_provider_id_external_transaction_id_unique"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_amount_check"
          check ("amount" >= 0),
        constraint "wager_transactions_kind_check"
          check ("kind" in (
            'OPENING', 'BET', 'WIN', 'LOSS',
            'REFUND', 'ROLLBACK'
          )),
        constraint "wager_transactions_status_check"
          check ("status" in (
            'PENDING', 'PENDING_REFERENCE',
            'PROCESSED', 'REJECTED', 'FAILED'
          )),
        constraint "wager_transactions_wallet_fk"
          foreign key ("wallet_id")
          references "wallets" ("id")
          on delete restrict
      );
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(10) not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_entries_pkey"
          primary key ("id"),
        constraint "wallet_ledger_entries_wallet_transaction_unique"
          unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_entries_wallet_fk"
          foreign key ("wallet_id")
          references "wallets" ("id")
          on delete restrict,
        constraint "wallet_ledger_entries_transaction_fk"
          foreign key ("transaction_id")
          references "wager_transactions" ("id")
          on delete restrict,
        constraint "wallet_ledger_entries_positive_amount"
          check ("amount" > 0),
        constraint "wallet_ledger_entries_direction_check"
          check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_balance_check"
          check (
            "balance_before" >= 0
            and "balance_after" >= 0
            and (
              ("direction" = 'DEBIT'
                and "balance_after" = "balance_before" - "amount")
              or
              ("direction" = 'CREDIT'
                and "balance_after" = "balance_before" + "amount")
            )
          )
      );
    `);

    this.addSql(`
      create or replace function prevent_wallet_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception
          'Ledger entries cannot be updated or deleted';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_immutable
      before update or delete on "wallet_ledger_entries"
      for each row
      execute function prevent_wallet_ledger_mutation();
    `);
  }

  override down(): void {
    this.addSql(`
      drop table if exists "wallet_ledger_entries";
    `);

    this.addSql(`
      drop function if exists prevent_wallet_ledger_mutation();
    `);

    this.addSql(`
      drop table if exists "wager_transactions";
    `);
  }
}
