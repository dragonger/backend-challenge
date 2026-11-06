import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Logger } from '@nestjs/common';

import {
  OutboxPublisher,
  outboxBackoffMs,
  type OutboxConfig,
} from '../../src/infrastructure/outbox/outbox-publisher.js';
import { closeTestContext, createTestContext, type TestContext } from '../helpers/db.js';
import { betCommand, count, seedWallet } from '../helpers/factories.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';
import { TestQueues } from '../helpers/sqs.js';

beforeAll(() => Logger.overrideLogger(false));

const outboxConfig = (overrides: Partial<OutboxConfig> = {}): OutboxConfig => ({
  enabled: true,
  pollIntervalMs: 50,
  batchSize: 7,
  backoffBaseMs: 100,
  backoffMaxMs: 1000,
  gaugeIntervalMs: 50,
  ...overrides,
});

let ctx: TestContext;
let queues: TestQueues;

const publisher = (overrides: Partial<OutboxConfig> = {}): OutboxPublisher =>
  new OutboxPublisher(ctx.runner, queues.sqs, ctx.metrics, outboxConfig(overrides));

afterEach(async () => {
  await assertLedgerInvariant(ctx.em);
  await queues.destroy();
  await closeTestContext(ctx);
});

/** Produces real outbox rows by processing real transactions. */
async function produceEvents(bets: number): Promise<void> {
  const wallets = await Promise.all(Array.from({ length: 4 }, () => seedWallet(ctx, '1000.00')));

  for (let i = 0; i < bets; i += 1) {
    await ctx.processor.execute(betCommand(wallets[i % wallets.length]!, { money: { amount: '1.00', currency: 'BRL' } }));
  }
}

describe('outbox publisher', () => {
  test('two concurrent publishers publish every event once and never the same row together', async () => {
    ctx = await createTestContext();
    queues = await TestQueues.create();
    await produceEvents(40);

    const total = await count(ctx, 'outbox_messages');

    expect(total).toBeGreaterThan(80);

    const a = publisher();
    const b = publisher();
    const run = async (p: OutboxPublisher): Promise<number> => {
      let picked = 0;

      for (;;) {
        const result = await p.publishBatch();

        if (result.picked === 0) {
          return picked;
        }

        picked += result.picked;
      }
    };
    const [pickedA, pickedB] = await Promise.all([run(a), run(b)]);

    // A row locked by one publisher is skipped by the other: the two sets are
    // disjoint, so the sum is exactly the number of rows.
    expect(pickedA + pickedB).toBe(total);
    expect(pickedA).toBeGreaterThan(0);
    expect(pickedB).toBeGreaterThan(0);
    expect(await count(ctx, 'outbox_messages', 'published_at is null')).toBe(0);

    const events = await queues.drain(queues.eventsUrl);
    const eventIds = events.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId);

    expect(eventIds.length).toBe(total);
    expect(new Set(eventIds).size).toBe(total);

    // Envelope: the README section 11 fields, Money as strings.
    const sample = JSON.parse(events[0]?.Body ?? '{}') as Record<string, unknown>;

    for (const field of ['eventId', 'eventType', 'aggregateId', 'correlationId', 'occurredAt', 'version', 'data']) {
      expect(sample).toHaveProperty(field);
    }

    expect(events[0]?.Attributes?.MessageGroupId).toBe(sample.aggregateId as string);
    expect(await ctx.metrics.outboxPublished.get().then((m) => m.values[0]?.value)).toBe(total);
  }, 60_000);

  test('SQS unavailable: events stay pending with backoff, nothing is lost, publishes after recovery', async () => {
    ctx = await createTestContext();
    queues = await TestQueues.create({ createEvents: false });
    await produceEvents(6);

    const total = await count(ctx, 'outbox_messages');
    const p = publisher({ batchSize: 50 });
    const failed = await p.publishBatch();

    expect(failed).toEqual({ picked: total, published: 0, failed: total });
    expect(await count(ctx, 'outbox_messages', 'published_at is null and attempts = 1 and last_error is not null and next_attempt_at > now()')).toBe(total);
    expect((await ctx.metrics.outboxPublishFailures.get()).values[0]?.value).toBe(total);

    // Backed off: the next immediate cycle finds nothing due.
    expect((await p.publishBatch()).picked).toBe(0);

    await p.updateGauges();
    expect((await ctx.metrics.outboxPending.get()).values[0]?.value).toBe(total);
    expect((await ctx.metrics.outboxLagSeconds.get()).values[0]?.value).toBeGreaterThanOrEqual(0);

    // SQS comes back; make the rows due now.
    await queues.createEventsQueue();
    await ctx.em.execute(`update outbox_messages set next_attempt_at = now()`);

    const recovered = await p.publishBatch();

    expect(recovered.published).toBe(total);
    expect(await count(ctx, 'outbox_messages', 'published_at is null')).toBe(0);
    expect((await queues.drain(queues.eventsUrl)).length).toBe(total);

    await p.updateGauges();
    expect((await ctx.metrics.outboxPending.get()).values[0]?.value).toBe(0);
    expect((await ctx.metrics.outboxLagSeconds.get()).values[0]?.value).toBe(0);
  }, 60_000);

  test('a republished event is harmless: same eventId, deduplicated by the FIFO queue', async () => {
    ctx = await createTestContext();
    queues = await TestQueues.create();
    await produceEvents(3);

    const total = await count(ctx, 'outbox_messages');
    const p = publisher({ batchSize: 100 });

    await p.publishBatch();
    // Simulates "published but the process died before marking published_at".
    await ctx.em.execute(`update outbox_messages set published_at = null`);
    await p.publishBatch();

    const events = await queues.drain(queues.eventsUrl);

    expect(events.length).toBe(total);
  }, 60_000);

  test('backoff grows exponentially with jitter and is capped', () => {
    const config = { backoffBaseMs: 1000, backoffMaxMs: 60_000 };

    expect(outboxBackoffMs(0, config, () => 0.5)).toBe(1000);
    expect(outboxBackoffMs(3, config, () => 0.5)).toBe(8000);
    expect(outboxBackoffMs(20, config, () => 0.5)).toBe(60_000);
    expect(outboxBackoffMs(2, config, () => 0)).toBe(3200);
    expect(outboxBackoffMs(2, config, () => 1)).toBe(4800);
  });
});
