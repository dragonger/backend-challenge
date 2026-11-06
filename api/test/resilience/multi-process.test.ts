import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';

import { closeTestContext, createTestContext, type TestContext } from '../helpers/db.js';
import { count, seedWallet, walletState, type SeededWallet } from '../helpers/factories.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';
import { Instance } from '../helpers/spawn-instance.js';
import { TestQueues, type WagerMessageInput } from '../helpers/sqs.js';
import { waitFor } from '../helpers/wait.js';

/**
 * REAL OS processes (`bun src/main.ts`) sharing one PostgreSQL database and one
 * set of SQS queues. Nothing here is mocked.
 */
let ctx: TestContext;
let queues: TestQueues;
let instances: Instance[] = [];

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.kill()));
  instances = [];
  await assertLedgerInvariant(ctx.em);
  await queues.destroy();
  await closeTestContext(ctx);
});

const start = async (...options: Parameters<typeof Instance.start>[1][]): Promise<Instance[]> => {
  const started = await Promise.all(options.map((o) => Instance.start(queues, o)));

  instances.push(...started);

  return started;
};

let sequence = 0;
const msg = (
  wallet: SeededWallet,
  overrides: Partial<WagerMessageInput> = {},
): WagerMessageInput => {
  sequence += 1;

  return {
    messageId: `m-${sequence}-${randomUUID().slice(0, 8)}`,
    walletId: wallet.walletId,
    playerId: wallet.playerId,
    externalTransactionId: `e-${sequence}-${randomUUID().slice(0, 8)}`,
    ...overrides,
  };
};

const queueIdle = async (): Promise<boolean> => (await queues.depth()) === 0;

describe('multi-process resilience', () => {
  test('worker killed after the commit and before the ack: another instance reprocesses with no duplicate effect', async () => {
    ctx = await createTestContext();
    queues = await TestQueues.create({ visibilityTimeout: 4 });
    const wallet = await seedWallet(ctx, '100.00');
    const doomed = await start({ consumer: true, crashAfterCommit: true, publisher: false });
    const [victim] = doomed;

    await queues.send([msg(wallet, { amount: '30.00' })]);

    // The process dies by itself at the seam (process.exit after the commit).
    const code = await Promise.race([
      victim!.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
    ]);

    expect(code).not.toBe('timeout');
    expect(code).not.toBe(0);

    // The effect is committed (and its events are in the outbox, unpublished)...
    expect((await walletState(ctx, wallet.walletId)).balance).toBe('70.00');
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(1);
    expect(await count(ctx, 'inbox_messages')).toBe(1);
    const pendingEvents = await count(ctx, 'outbox_messages', 'published_at is null');

    expect(pendingEvents).toBeGreaterThanOrEqual(3);
    expect(pendingEvents).toBe(await count(ctx, 'outbox_messages'));
    // ...but the message was never acknowledged.
    expect(await queues.depth()).toBe(1);

    // Another instance takes over: consumer redelivery (after the visibility
    // timeout) AND the outbox publisher that the dead one never ran.
    const [heir] = await start({ consumer: true, publisher: true });

    await waitFor('redelivered message acked', queueIdle, 40_000, 500);
    await waitFor('outbox published', async () => (await count(ctx, 'outbox_messages', 'published_at is null')) === 0, 20_000);

    expect((await walletState(ctx, wallet.walletId)).balance).toBe('70.00');
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(1);
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(1);
    // The second delivery was recognised by the inbox, not processed again.
    expect(await heir!.metric('sqs_messages_total', { outcome: 'replay' })).toBe(1);
    expect(await heir!.metric('sqs_messages_total', { outcome: 'processed' })).toBe(0);

    const events = await queues.drain(queues.eventsUrl);

    expect(events.length).toBe(pendingEvents);
  }, 120_000);

  test('three instances consume hundreds of messages (duplicates, hot wallet) and the invariants hold', async () => {
    ctx = await createTestContext();
    queues = await TestQueues.create({ visibilityTimeout: 30 });

    // Hot wallet: 100.00 and 40 bets of 10.00 -> exactly 10 can win the balance.
    const hot = await seedWallet(ctx, '100.00');
    const hotMessages = Array.from({ length: 40 }, () => msg(hot, { amount: '10.00' }));
    // 30 ordinary wallets, 8 bets of 10.00 each.
    const wallets = await Promise.all(Array.from({ length: 30 }, () => seedWallet(ctx, '1000.00')));
    const ordinary = wallets.flatMap((wallet) => Array.from({ length: 8 }, () => msg(wallet, { amount: '10.00' })));
    // 60 duplicates (same body, second physical delivery) + 10 re-sends of hot-wallet messages.
    const duplicates = [...ordinary.slice(0, 60), ...hotMessages.slice(0, 10)];
    const unique = hotMessages.length + ordinary.length;

    await queues.send([...hotMessages, ...ordinary]);
    await queues.send(duplicates, true);

    const fleet = await start(
      { consumer: true, publisher: true, pendingWorker: true },
      { consumer: true, publisher: true, pendingWorker: true },
      { consumer: true, publisher: true, pendingWorker: true },
    );

    await waitFor('all messages consumed', async () => (await count(ctx, 'wager_transactions', `kind = 'BET'`)) === unique && (await queueIdle()), 120_000, 500);
    await waitFor('outbox fully published', async () => (await count(ctx, 'outbox_messages', 'published_at is null')) === 0, 60_000, 500);

    // Hot wallet: exactly one outcome per bet, never a negative balance.
    expect(await count(ctx, 'wager_transactions', `wallet_id = '${hot.walletId}' and status = 'PROCESSED' and kind = 'BET'`)).toBe(10);
    expect(await count(ctx, 'wager_transactions', `wallet_id = '${hot.walletId}' and status = 'REJECTED' and failure_code = 'INSUFFICIENT_BALANCE'`)).toBe(30);
    expect((await walletState(ctx, hot.walletId)).balance).toBe('0.00');

    for (const wallet of wallets) {
      expect((await walletState(ctx, wallet.walletId)).balance).toBe('920.00');
    }

    // One inbox row and one transaction per distinct message; duplicates left no trace.
    expect(await count(ctx, 'inbox_messages')).toBe(unique);
    expect(await count(ctx, 'wager_transactions', `kind = 'BET'`)).toBe(unique);
    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(10 + wallets.length * 8);

    // Every instance did useful work and the duplicates were all recognised.
    const processedBy = await Promise.all(fleet.map((i) => i.metric('sqs_messages_total', { outcome: 'processed' })));
    const rejectedBy = await Promise.all(fleet.map((i) => i.metric('sqs_messages_total', { outcome: 'rejected' })));
    const replays = (await Promise.all(fleet.map((i) => i.metric('sqs_messages_total', { outcome: 'replay' })))).reduce((a, b) => a + b, 0);

    expect(processedBy.reduce((a, b) => a + b, 0) + rejectedBy.reduce((a, b) => a + b, 0)).toBe(unique);
    expect(processedBy.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
    expect(replays).toBe(duplicates.length);

    // Events: all outbox rows published, none lost, ids unique.
    const events = await queues.drain(queues.eventsUrl, 1, 200);
    const ids = new Set(events.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId));
    const outbox = await count(ctx, 'outbox_messages');

    expect(ids.size).toBe(outbox);
  }, 240_000);

  test('restart: an instance killed in the middle of the run, a new one finishes with exactly-once effects', async () => {
    ctx = await createTestContext();
    queues = await TestQueues.create({ visibilityTimeout: 5 });
    const wallets = await Promise.all(Array.from({ length: 10 }, () => seedWallet(ctx, '500.00')));
    const messages = wallets.flatMap((wallet) => Array.from({ length: 10 }, () => msg(wallet, { amount: '5.00' })));

    await queues.send(messages);

    const [first] = await start({ consumer: true, publisher: true });

    await waitFor('some progress', async () => (await count(ctx, 'wager_transactions', `kind = 'BET'`)) >= 15, 60_000, 100);
    await first!.kill();

    const doneAtKill = await count(ctx, 'wager_transactions', `kind = 'BET'`);

    expect(doneAtKill).toBeLessThan(messages.length + 1);

    await start({ consumer: true, publisher: true });
    await waitFor('everything processed after the restart', async () => (await count(ctx, 'wager_transactions', `kind = 'BET'`)) === messages.length && (await queueIdle()), 120_000, 500);
    await waitFor('outbox published', async () => (await count(ctx, 'outbox_messages', 'published_at is null')) === 0, 60_000, 500);

    for (const wallet of wallets) {
      expect((await walletState(ctx, wallet.walletId)).balance).toBe('450.00');
    }

    expect(await count(ctx, 'wallet_ledger_entries', `direction = 'DEBIT'`)).toBe(messages.length);
    expect(await count(ctx, 'inbox_messages')).toBe(messages.length);
  }, 240_000);
});
