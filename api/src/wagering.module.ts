import { Module } from '@nestjs/common';

import {
  PENDING_REFERENCE_CONFIG,
  pendingReferenceConfigFromEnv,
} from './application/wagering/pending-reference.policy.js';
import { GetWagerTransaction } from './application/wagering/get-wager-transaction.usecase.js';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction.usecase.js';
import { ResolvePendingTransaction } from './application/wagering/resolve-pending-transaction.usecase.js';
import { GetWallet } from './application/wallet/get-wallet.usecase.js';
import { ListLedger } from './application/wallet/list-ledger.usecase.js';
import { OpenWallet } from './application/wallet/open-wallet.usecase.js';
import { ReconcileWallet } from './application/wallet/reconcile-wallet.usecase.js';
import { lockTimeoutMsFromEnv } from './infrastructure/database/mikro-orm.config.js';
import { PendingTransactionsRepository } from './infrastructure/database/pending-transactions.repository.js';
import {
  LOCK_TIMEOUT_MS,
  TransactionRunner,
} from './infrastructure/database/transaction-runner.js';
import { MetricsModule } from './infrastructure/metrics/metrics.module.js';

/** Financial core: use cases and their transactional runner. */
@Module({
  imports: [MetricsModule],
  providers: [
    { provide: LOCK_TIMEOUT_MS, useFactory: lockTimeoutMsFromEnv },
    { provide: PENDING_REFERENCE_CONFIG, useFactory: pendingReferenceConfigFromEnv },
    TransactionRunner,
    PendingTransactionsRepository,
    ProcessWagerTransaction,
    ResolvePendingTransaction,
    OpenWallet,
    GetWallet,
    ListLedger,
    GetWagerTransaction,
    ReconcileWallet,
  ],
  exports: [
    ProcessWagerTransaction,
    ResolvePendingTransaction,
    PendingTransactionsRepository,
    OpenWallet,
    GetWallet,
    ListLedger,
    GetWagerTransaction,
    ReconcileWallet,
    TransactionRunner,
    MetricsModule,
  ],
})
export class WageringModule {}
