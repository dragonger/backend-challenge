import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.usecase.js';
import { OpenWallet } from '../../src/application/wallet/open-wallet.usecase.js';
import {
  buildMikroOrmConfig,
  testDatabaseName,
} from '../../src/infrastructure/database/mikro-orm.config.js';
import { WageringModule } from '../../src/wagering.module.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';

/**
 * Smoke test of the Nest wiring under Bun: decorator metadata must be emitted
 * so that constructor injection works with the real container.
 */
describe('Nest bootstrap', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot(buildMikroOrmConfig({ dbName: testDatabaseName() })),
        WageringModule,
      ],
    }).compile();
    await moduleRef.init();
  });

  afterEach(async () => {
    await assertLedgerInvariant(moduleRef.get(EntityManager).fork());
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  test('resolves the use cases through dependency injection and runs a bet', async () => {
    const openWallet = moduleRef.get(OpenWallet);
    const processor = moduleRef.get(ProcessWagerTransaction);
    const playerId = randomUUID();

    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: '20.00', currency: 'BRL' },
    });

    const result = await processor.execute({
      providerId: 'provider-di',
      externalTransactionId: `di-${wallet.id}`,
      idempotencyKey: `provider-di:di-${wallet.id}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '5.00', currency: 'BRL' },
    });

    expect(String(result.status)).toBe('PROCESSED');
    expect(result.balance).toEqual({ amount: '15.00', currency: 'BRL' });
  });
});
