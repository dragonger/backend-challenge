import 'reflect-metadata';

import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';

import { WalletEntity } from './entities/wallet.entity.js';
import { WagerTransactionEntity } from './entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity.js';
import { InboxMessageEntity } from './entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './entities/outbox-message.entity.js';

loadEnv({
  path: new URL('../../../../.env', import.meta.url),
  quiet: true,
});

const required = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
};

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === '' ? fallback : Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
};

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export const lockTimeoutMsFromEnv = (): number =>
  numberFromEnv('LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS);

export const testDatabaseName = (): string =>
  process.env.DB_NAME_TEST || 'jungle_wagering_test';

export interface MikroOrmOverrides {
  dbName?: string;
  poolMax?: number;
  /** Silences the migrator log (tests). */
  silentMigrations?: boolean;
}

export const buildMikroOrmConfig = (overrides: MikroOrmOverrides = {}) =>
  defineConfig({
    host: required('DB_HOST'),
    port: Number(required('DB_PORT')),
    dbName: overrides.dbName ?? required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),

    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ],

    metadataProvider: ReflectMetadataProvider,

    pool: {
      min: 2,
      max: overrides.poolMax ?? numberFromEnv('DB_POOL_MAX', 20),
    },

    extensions: [Migrator],

    // Schema changes are hand-written SQL migrations (check constraints,
    // partial indexes, triggers), so no entity snapshot is kept.
    migrations: {
      path: fileURLToPath(new URL('./migrations', import.meta.url)),
      pathTs: fileURLToPath(new URL('./migrations', import.meta.url)),
      glob: 'Migration*.{ts,js}',
      snapshot: false,
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
      silent: overrides.silentMigrations ?? false,
    },
  });

export default buildMikroOrmConfig();
