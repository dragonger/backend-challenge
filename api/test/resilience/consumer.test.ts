import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';

import {
  PendingReferenceWorker,
  type PendingWorkerConfig,
} from '../../src/infrastructure/workers/pending-reference.worker.js';
import {
  WagerTransactionConsumer,
  type ConsumerConfig,
} from '../../src/interfaces/messaging/wager-transaction.consumer.js';
import { closeTestContext, createTestContext, type TestContext } from '../helpers/db.js';
import { count, nextId, seedWallet, walletState, type SeededWallet } from '../helpers/factories.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';
import { TestQueues, type WagerMessageInput } from '../helpers/sqs.js';
import { sleep, waitFor } from '../helpers/wait.js';

/**
 * Consumer behaviour against real PostgreSQL and real (LocalStack) SQS queues,
 * in one process. Each test gets its own queues and an empty database.
 */
const consumerConfig = (overrides: Partial<ConsumerConfig> = {}): ConsumerConfig => ({
  enabled: true,
  concurrency: 10,
  waitTimeSeconds: 1,
  retryBaseSeconds: 1,
  retryMaxSeconds: 2,
  maxReceiveCount: 5,
  crashAfterCommit: false,
  ...overrides,
});

// Quiet the Nest logger of the components under test.
beforeAll(() => Logger.overrideLogger(false));

let ctx: TestContext;
let queues: TestQueues;
let consumer: WagerTransactionConsumer | undefined;

async function setup(
  queueOptions: Parameters<typeof TestQueues.create>[0] = {},
  consumerOverrides: Partial<ConsumerConfig> = {},
  contextOptions: Parameters<typeof createTestContext>[0] = {},
): Promise<void> {
  ctx = await createTestContext(contextOptions);
  queues = await TestQueues.create(queueOptions);
  consumer = new WagerTransactionConsumer(
    queues.sqs,
    ctx.processor,
    ctx.metrics,
    consumerConfig(consumerOverrides),
  );
}

const message = (
  wallet: SeededWallet,
  overrides: Partial<WagerMessageInput> = {},
): WagerMessageInput => ({
  messageId: nextId('msg'),
  walletId: wallet.walletId,
  playerId: wallet.playerId,
  externalTransactionId: nextId('ext'),
  ...overrides,
});

const counter = async (name: string, labels: Record<string, string> = {}): Promise<number> => {
  const metric = await ctx.metrics.registry.getSingleMetricAsString(name);
  let total = 0;

  for (const line of metric.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) {
      continue;
    }

    const [series, value] = [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)];

    if (Object.entries(labels).every(([key, v]) => series.includes(`${key}="${v}"`))) {
      total += Number(value);
    }
  }

  return total;
};

afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  await assertLedgerInvariant(ctx.em);
  await queues.destroy();
  await closeTestContext(ctx);
});

describe('SQS consumer', () => {
  test('the same message delivered twice has a single effect', async () => {
    await setup();
    const wallet = await seedWallet(ctx, '100.00');
    const bet = message(wallet, { amount: '10.00' });

    // Two physical deliveries of the identical body (producer retry / redelivery).
    await queues.send([bet, bet], true);
    consumer!.start();

    await waitFor('both deliveries consumed', async () => (await queues.depth()) === 0 && (await counter('sqs_messages_total')) >= 2);
    await consumer!.stop();

    expect((await walletState(ctx, wallet.walletId)).balance).toBe('90.00');
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(1);
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
    expect(await count(ctx, 'inbox_messages')).toBe(1);
    expect(await counter('sqs_messages_total', { outcome: 'processed' })).toBe(1);
    expect(await counter('sqs_messages_total', { outcome: 'replay' })).toBe(1);
    expect(await counter('idempotent_replays_total', { channel: 'sqs' })).toBe(1);
  });

  test('business results are acknowledged: rejection, idempotency conflict, unknown wallet', async () => {
    await setup();
    const wallet = await seedWallet(ctx, '5.00');
    const rejected = message(wallet, { amount: '10.00' });
    const original = message(wallet, { amount: '1.00' });
    const conflicting = message(wallet, {
      amount: '2.00',
      externalTransactionId: original.externalTransactionId,
    });
    const ghost = message({ walletId: randomUUID(), playerId: randomUUID() });

    await queues.send([rejected, original, conflicting, ghost]);
    consumer!.start();

    await waitFor('all acked', async () => (await queues.depth()) === 0);
    await consumer!.stop();

    expect(await count(ctx, 'wager_transactions', `status = 'REJECTED' and failure_code = 'INSUFFICIENT_BALANCE'`)).toBe(1);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('4.00');
    expect(await counter('sqs_messages_total', { outcome: 'idempotency_conflict' })).toBe(1);
    expect(await counter('sqs_messages_total', { outcome: 'wallet_not_found' })).toBe(1);
    expect(await counter('idempotency_conflicts_total')).toBe(1);
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });

  test('malformed messages go to the DLQ with a reason and leave the main queue', async () => {
    await setup();
    const wallet = await seedWallet(ctx, '100.00');
    const good = message(wallet);
    const base = JSON.parse(
      JSON.stringify({
        messageId: 'x',
        type: 'WagerTransactionRequested',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: {
          providerId: 'p',
          externalTransactionId: 'e',
          idempotencyKey: 'p:e',
          playerId: wallet.playerId,
          walletId: wallet.walletId,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        },
      }),
    ) as { data: Record<string, unknown> } & Record<string, unknown>;
    const poison = (id: string, body: string): WagerMessageInput => ({ ...message(wallet), messageId: id, raw: body });

    await queues.send([
      poison('p1', '{not json'),
      poison('p2', JSON.stringify({ ...base, type: 'SomethingElse' })),
      poison('p3', JSON.stringify({ ...base, data: { ...base.data, kind: 'OPENING' } })),
      poison('p4', JSON.stringify({ ...base, messageId: 'p4', data: { ...base.data, money: { amount: '1000000000000000000000.00', currency: 'BRL' } } })),
      good,
    ]);
    consumer!.start();

    await waitFor('main queue drained', async () => (await queues.depth()) === 0);
    await consumer!.stop();

    const dead = await queues.drain(queues.dlqUrl);
    const reasons = dead
      .map((m) => m.MessageAttributes?.FailureReason?.StringValue ?? '')
      .sort((a, b) => a.localeCompare(b));

    expect(reasons).toEqual(['INVALID_COMMAND', 'INVALID_SCHEMA', 'MALFORMED_JSON', 'UNKNOWN_MESSAGE_TYPE']);
    expect(dead.every((m) => Boolean(m.MessageAttributes?.FailureDetail?.StringValue))).toBe(true);
    expect(await counter('sqs_dlq_total', { reason: 'MALFORMED_JSON' })).toBe(1);
    expect(await counter('sqs_dlq_total')).toBe(4);
    // The healthy message was processed normally.
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('90.00');
  });

  test('transient failure (real lock timeout) is retried with backoff and then succeeds', async () => {
    await setup({ visibilityTimeout: 30 }, {}, { lockTimeoutMs: 200 });
    const wallet = await seedWallet(ctx, '100.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // Another transaction keeps the wallet row locked, so the consumer's
    // transaction hits lock_timeout (a TransientInfrastructureError).
    const blocker = ctx.orm.em.fork().transactional(async (tx) => {
      await tx.execute(`select 1 from wallets where id = ? for update`, [wallet.walletId]);
      locked();
      await held;
    });

    await lockAcquired;
    await queues.send([message(wallet, { amount: '10.00' })]);
    consumer!.start();

    await waitFor('first retry scheduled', async () => (await counter('sqs_retries_total')) >= 1, 20_000);
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(0);
    expect(await counter('lock_conflicts_total')).toBeGreaterThanOrEqual(1);

    release();
    await blocker;

    await waitFor('message processed after the lock is gone', async () => (await counter('sqs_messages_total', { outcome: 'processed' })) === 1, 30_000);
    await consumer!.stop();

    expect((await walletState(ctx, wallet.walletId)).balance).toBe('90.00');
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
  });

  test('a message that keeps failing is moved to the DLQ by the redrive policy', async () => {
    await setup({ visibilityTimeout: 30, maxReceiveCount: 2 }, { maxReceiveCount: 2 }, { lockTimeoutMs: 150 });
    const wallet = await seedWallet(ctx, '100.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = ctx.orm.em.fork().transactional(async (tx) => {
      await tx.execute(`select 1 from wallets where id = ? for update`, [wallet.walletId]);
      locked();
      await held;
    });

    await lockAcquired;
    await queues.send([message(wallet, { amount: '10.00' })]);
    consumer!.start();

    try {
      await waitFor('redrive to the DLQ', async () => (await queues.depth(queues.dlqUrl)) === 1, 60_000, 500);
    } finally {
      release();
      await blocker;
    }

    await consumer!.stop();
    expect(await queues.depth()).toBe(0);
    expect(await counter('sqs_retries_total')).toBeGreaterThanOrEqual(2);
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(0);
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('100.00');
  }, 90_000);

  test('ROLLBACK before its BET becomes PENDING_REFERENCE and the worker resolves it', async () => {
    await setup({}, {}, { pendingReference: { initialBackoffMs: 100, maxBackoffMs: 300, maxAttempts: 50, ttlMs: 60_000 } });
    const wallet = await seedWallet(ctx, '100.00');
    const betExternalId = nextId('bet');
    const rollback = message(wallet, { kind: 'ROLLBACK', amount: '25.00', externalTransactionId: nextId('rb'), referenceExternalTransactionId: betExternalId });
    const bet = message(wallet, { kind: 'BET', externalTransactionId: betExternalId, amount: '25.00' });
    const workerConfig: PendingWorkerConfig = { enabled: true, pollIntervalMs: 100, batchSize: 20, concurrency: 2 };
    const worker = new PendingReferenceWorker(ctx.pending, ctx.resolver, workerConfig);

    consumer!.start();
    worker.start();

    try {
      await queues.send([rollback]);
      await waitFor('rollback parked as pending', async () => (await count(ctx, 'wager_transactions', `status = 'PENDING_REFERENCE'`)) === 1);

      await queues.send([bet]);
      await waitFor('rollback resolved by the worker', async () => (await count(ctx, 'wager_transactions', `kind = 'ROLLBACK' and status = 'PROCESSED'`)) === 1, 30_000);
    } finally {
      await worker.stop();
    }

    await consumer!.stop();
    // BET debited 25.00, the ROLLBACK credited it back.
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('100.00');
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'CREDIT' and transaction_id in (select id from wager_transactions where kind = 'ROLLBACK')`)).toBe(1);
    expect(await counter('wager_transactions_total', { channel: 'worker', status: 'PROCESSED' })).toBe(1);
    expect(await count(ctx, 'outbox_messages', `event_type = 'WagerTransactionPendingReference'`)).toBe(1);
  });

  test('graceful stop finishes what is running and returns the untouched messages', async () => {
    await setup({ visibilityTimeout: 60 }, { concurrency: 4 });
    const wallets: SeededWallet[] = [];

    for (let i = 0; i < 6; i += 1) {
      wallets.push(await seedWallet(ctx, '1000.00'));
    }

    const messages = wallets.flatMap((wallet) =>
      Array.from({ length: 5 }, () => message(wallet, { amount: '10.00' })),
    );

    await queues.send(messages);
    consumer!.start();
    await waitFor('some messages processed', async () => (await count(ctx, 'wager_transactions', `kind = 'BET'`)) >= 3);

    // Same sequence Nest runs on SIGTERM (onModuleDestroy) before the ORM closes.
    await consumer!.stop();

    const doneAtStop = await count(ctx, 'wager_transactions', `kind = 'BET'`);

    await sleep(500);
    // Nothing runs after stop() returned.
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(doneAtStop);
    // Everything not processed is back on the queue immediately (visibility 0),
    // not stuck invisible for the 60s visibility timeout.
    const visible = Number(
      (
        await queues.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queues.mainUrl,
            AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
          }),
        )
      ).Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0,
    );

    expect(visible).toBe(0);

    // A new consumer finishes the job with no duplicated effect.
    const second = new WagerTransactionConsumer(queues.sqs, ctx.processor, ctx.metrics, consumerConfig());

    second.start();
    await waitFor('all processed', async () => (await count(ctx, 'wager_transactions', `kind = 'BET'`)) === messages.length, 30_000);
    await second.stop();

    for (const wallet of wallets) {
      expect((await walletState(ctx, wallet.walletId)).balance).toBe('950.00');
    }

    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(messages.length);
  }, 60_000);
});

