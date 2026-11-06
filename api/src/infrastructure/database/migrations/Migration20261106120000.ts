import { Migration } from '@mikro-orm/migrations';

/**
 * Completes the schema for the financial core:
 *  - result snapshot in wager_transactions (replay fidelity, also for REJECTED)
 *  - reference rules enforced by the database
 *  - at most ONE processed reversal (REFUND or ROLLBACK) per referenced tx
 *  - retry bookkeeping for PENDING_REFERENCE
 *  - inbox / outbox tables
 *  - stable ordering column for the ledger
 */
export class Migration20261106120000 extends Migration {
  override name = 'Migration20261106120000';

  override up(): void {
    // ---- wallets
    this.addSql(`
      alter table "wallets"
        add constraint "wallets_version_positive" check ("version" >= 1),
        add constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$');
    `);

    // ---- wager_transactions
    this.addSql(`
      alter table "wager_transactions"
        add column "balance_after" numeric(20,2),
        add column "attempts" int not null default 0,
        add column "next_attempt_at" timestamptz;
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_reference_tx_fk"
          foreign key ("reference_transaction_id")
          references "wager_transactions" ("id")
          on delete restrict,
        add constraint "wager_transactions_no_self_reference"
          check ("reference_transaction_id" is null
                 or "reference_transaction_id" <> "id"),
        add constraint "wager_transactions_reversal_requires_reference"
          check ("kind" not in ('REFUND', 'ROLLBACK')
                 or "reference_external_transaction_id" is not null),
        add constraint "wager_transactions_processed_reversal_resolved"
          check ("kind" not in ('REFUND', 'ROLLBACK')
                 or "status" <> 'PROCESSED'
                 or "reference_transaction_id" is not null),
        add constraint "wager_transactions_amount_positive_except_loss"
          check ("kind" = 'LOSS' or "amount" > 0),
        add constraint "wager_transactions_currency_format"
          check ("currency" ~ '^[A-Z]{3}$'),
        add constraint "wager_transactions_terminal_has_processed_at"
          check ("status" not in ('PROCESSED', 'REJECTED', 'FAILED')
                 or "processed_at" is not null),
        add constraint "wager_transactions_processed_has_snapshot"
          check ("status" <> 'PROCESSED'
                 or ("balance_after" is not null and "failure_code" is null)),
        add constraint "wager_transactions_failed_has_code"
          check ("status" not in ('REJECTED', 'FAILED')
                 or "failure_code" is not null),
        add constraint "wager_transactions_pending_reference_scheduled"
          check ("status" <> 'PENDING_REFERENCE'
                 or "next_attempt_at" is not null),
        add constraint "wager_transactions_attempts_non_negative"
          check ("attempts" >= 0);
    `);

    // A transaction can be reversed only once, by REFUND or by ROLLBACK,
    // so the same credit/debit is never applied twice.
    this.addSql(`
      create unique index "wager_transactions_one_reversal_per_reference"
        on "wager_transactions" ("reference_transaction_id")
        where "status" = 'PROCESSED'
          and "kind" in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create index "wager_transactions_pending_reference_due_idx"
        on "wager_transactions" ("next_attempt_at")
        where "status" = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create index "wager_transactions_wallet_created_idx"
        on "wager_transactions" ("wallet_id", "created_at");
    `);

    this.addSql(`
      create index "wager_transactions_reference_tx_idx"
        on "wager_transactions" ("reference_transaction_id")
        where "reference_transaction_id" is not null;
    `);

    // ---- ledger ordering (stable keyset pagination). ALTER TABLE does not
    // fire the row-level immutability trigger.
    this.addSql(`
      alter table "wallet_ledger_entries"
        add column "sequence" bigint generated always as identity;
    `);

    this.addSql(`
      create unique index "wallet_ledger_entries_sequence_idx"
        on "wallet_ledger_entries" ("sequence");
    `);

    this.addSql(`
      create index "wallet_ledger_entries_wallet_sequence_idx"
        on "wallet_ledger_entries" ("wallet_id", "sequence");
    `);

    // ---- inbox
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(100) not null,
        "message_id" varchar(255) not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz,
        constraint "inbox_messages_pkey"
          primary key ("consumer_name", "message_id")
      );
    `);

    // ---- outbox
    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "sequence" bigint generated always as identity,
        "aggregate_id" varchar(150) not null,
        "event_type" varchar(100) not null,
        "payload" jsonb not null,
        "attempts" int not null default 0,
        "next_attempt_at" timestamptz not null default now(),
        "published_at" timestamptz,
        "last_error" text,
        "created_at" timestamptz not null default now(),
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_attempts_non_negative"
          check ("attempts" >= 0)
      );
    `);

    this.addSql(`
      create index "outbox_messages_pending_idx"
        on "outbox_messages" ("next_attempt_at", "sequence")
        where "published_at" is null;
    `);

    this.addSql(`
      create unique index "outbox_messages_sequence_idx"
        on "outbox_messages" ("sequence");
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists "outbox_messages";`);
    this.addSql(`drop table if exists "inbox_messages";`);

    this.addSql(`
      drop index if exists "wallet_ledger_entries_wallet_sequence_idx";
    `);
    this.addSql(`drop index if exists "wallet_ledger_entries_sequence_idx";`);
    this.addSql(`
      alter table "wallet_ledger_entries" drop column "sequence";
    `);

    this.addSql(`drop index if exists "wager_transactions_reference_tx_idx";`);
    this.addSql(`drop index if exists "wager_transactions_wallet_created_idx";`);
    this.addSql(`
      drop index if exists "wager_transactions_pending_reference_due_idx";
    `);
    this.addSql(`
      drop index if exists "wager_transactions_one_reversal_per_reference";
    `);

    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_attempts_non_negative",
        drop constraint "wager_transactions_pending_reference_scheduled",
        drop constraint "wager_transactions_failed_has_code",
        drop constraint "wager_transactions_processed_has_snapshot",
        drop constraint "wager_transactions_terminal_has_processed_at",
        drop constraint "wager_transactions_currency_format",
        drop constraint "wager_transactions_amount_positive_except_loss",
        drop constraint "wager_transactions_processed_reversal_resolved",
        drop constraint "wager_transactions_reversal_requires_reference",
        drop constraint "wager_transactions_no_self_reference",
        drop constraint "wager_transactions_reference_tx_fk";
    `);

    this.addSql(`
      alter table "wager_transactions"
        drop column "next_attempt_at",
        drop column "attempts",
        drop column "balance_after";
    `);

    this.addSql(`
      alter table "wallets"
        drop constraint "wallets_currency_format",
        drop constraint "wallets_version_positive";
    `);
  }
}
