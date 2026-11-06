import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import {
  buildMikroOrmConfig,
  testDatabaseName,
} from '../../src/infrastructure/database/mikro-orm.config.js';
import { TransactionRunner } from '../../src/infrastructure/database/transaction-runner.js';
import { OpenWallet } from '../../src/application/wallet/open-wallet.usecase.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.usecase.js';
import {
  DEFAULT_PENDING_REFERENCE_CONFIG,
  type PendingReferenceConfig,
} from '../../src/application/wagering/pending-reference.policy.js';
import { ResolvePendingTransaction } from '../../src/application/wagering/resolve-pending-transaction.usecase.js';
import { ReconcileWallet } from '../../src/application/wallet/reconcile-wallet.usecase.js';
import { PendingTransactionsRepository } from '../../src/infrastructure/database/pending-transactions.repository.js';
import { MetricsService } from '../../src/infrastructure/metrics/metrics.service.js';

export interface TestContext {
  orm: MikroORM;
  em: EntityManager;
  runner: TransactionRunner;
  openWallet: OpenWallet;
  processor: ProcessWagerTransaction;
  resolver: ResolvePendingTransaction;
  pending: PendingTransactionsRepository;
  reconciler: ReconcileWallet;
  metrics: MetricsService;
}

export interface TestContextOptions {
  lockTimeoutMs?: number;
  pendingReference?: Partial<PendingReferenceConfig>;
}

/**
 * Connects to the dedicated test database (created on demand, migrations
 * applied) and wires the real use cases. Never touches the development
 * database. The pool is large enough for real parallelism.
 */
export async function createTestContext(
  options: TestContextOptions = {},
): Promise<TestContext> {
  const dbName = testDatabaseName();

  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests on database "${dbName}"`);
  }

  const orm = await MikroORM.init(buildMikroOrmConfig({ dbName, poolMax: 60, silentMigrations: true }));

  await orm.schema.ensureDatabase();
  await orm.migrator.up();
  await resetDatabase(orm.em);

  const metrics = new MetricsService();
  const runner = new TransactionRunner(orm.em, options.lockTimeoutMs ?? 5000, metrics);
  const pendingConfig: PendingReferenceConfig = {
    ...DEFAULT_PENDING_REFERENCE_CONFIG,
    ...options.pendingReference,
  };

  return {
    orm,
    em: orm.em.fork(),
    runner,
    openWallet: new OpenWallet(runner),
    processor: new ProcessWagerTransaction(runner, pendingConfig, metrics),
    resolver: new ResolvePendingTransaction(runner, pendingConfig, metrics),
    pending: new PendingTransactionsRepository(runner),
    reconciler: new ReconcileWallet(runner, metrics),
    metrics,
  };
}

/**
 * The ledger trigger blocks DELETE, so tables are emptied with TRUNCATE
 * (row-level triggers do not fire on TRUNCATE).
 */
export async function resetDatabase(em: EntityManager): Promise<void> {
  await em.execute(
    `truncate table outbox_messages, inbox_messages, wallet_ledger_entries,
       wager_transactions, wallets restart identity cascade`,
  );
}

export async function closeTestContext(ctx: TestContext): Promise<void> {
  await ctx.orm.close(true);
}
