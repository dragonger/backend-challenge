import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import {
  PROVIDER_IDENTITY,
  type ProviderIdentityPort,
} from '../../src/application/ports/provider-identity.port.js';
import { buildMikroOrmConfig, testDatabaseName } from '../../src/infrastructure/database/mikro-orm.config.js';
import { LOCK_TIMEOUT_MS } from '../../src/infrastructure/database/transaction-runner.js';
import { MetricsService } from '../../src/infrastructure/metrics/metrics.service.js';
import { SQS_CONFIG, sqsConfigFromEnv } from '../../src/infrastructure/sqs/sqs.config.js';
import { HttpModule } from '../../src/interfaces/http/http.module.js';
import { closeTestContext, createTestContext, resetDatabase, type TestContext } from '../helpers/db.js';
import { assertLedgerInvariant } from '../helpers/invariants.js';

interface Reply {
  status: number;
  // oxlint-disable-next-line no-explicit-any
  json: any;
  headers: Headers;
}

let ctx: TestContext;
let app: INestApplication;
let baseUrl: string;

async function startApp(
  customize: (builder: ReturnType<typeof Test.createTestingModule>) => ReturnType<typeof Test.createTestingModule> = (b) => b,
): Promise<{ app: INestApplication; baseUrl: string }> {
  const builder = Test.createTestingModule({
    imports: [
      MikroOrmModule.forRoot(buildMikroOrmConfig({ dbName: testDatabaseName(), poolMax: 30 })),
      HttpModule,
    ],
  });
  const moduleRef = await customize(builder.overrideProvider(LOCK_TIMEOUT_MS).useValue(300)).compile();
  const nest = moduleRef.createNestApplication();
  await nest.listen(0, '127.0.0.1');
  const { port } = (nest.getHttpServer() as Server).address() as AddressInfo;

  return { app: nest, baseUrl: `http://127.0.0.1:${port}` };
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; raw?: string; url?: string } = {},
): Promise<Reply> {
  const hasBody = options.body !== undefined || options.raw !== undefined;
  const response = await fetch(`${options.url ?? baseUrl}${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const text = await response.text();

  return {
    status: response.status,
    json: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

const createWallet = async (balance = '100.00', playerId: string = randomUUID()) => {
  const reply = await call('POST', '/wallets', {
    body: { playerId, initialBalance: { amount: balance, currency: 'BRL' } },
  });
  expect(reply.status).toBe(201);

  return { walletId: reply.json.id as string, playerId };
};

let seq = 0;

const body = (
  wallet: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) => {
  seq += 1;

  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}-${randomUUID().slice(0, 6)}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
};

const submit = (payload: ReturnType<typeof body>, key?: string, headers: Record<string, string> = {}) =>
  call('POST', '/wagering/transactions', {
    body: payload,
    headers: {
      'idempotency-key': key ?? `${payload.providerId}:${payload.externalTransactionId}`,
      ...headers,
    },
  });

beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestContext();
  ({ app, baseUrl } = await startApp());
});

beforeEach(async () => {
  await resetDatabase(ctx.em);
});

afterEach(async () => {
  await assertLedgerInvariant(ctx.em);
});

afterAll(async () => {
  await app.close();
  await closeTestContext(ctx);
});

describe('POST /wallets', () => {
  test('201 with id, playerId, balance and version 1', async () => {
    const playerId = randomUUID();
    const reply = await call('POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '1000', currency: 'BRL' } },
    });

    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('409 for the same playerId + currency, another currency is fine', async () => {
    const playerId = randomUUID();
    const payload = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };

    expect((await call('POST', '/wallets', { body: payload })).status).toBe(201);
    const duplicate = await call('POST', '/wallets', { body: payload });

    expect(duplicate.status).toBe(409);
    expect(duplicate.json.error.code).toBe('WALLET_ALREADY_EXISTS');
    expect(
      (await call('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '1.00', currency: 'USD' } },
      })).status,
    ).toBe(201);
  });

  test.each([
    ['unknown field', { extra: 1 }],
    ['numeric amount', { initialBalance: { amount: 10, currency: 'BRL' } }],
    ['negative amount', { initialBalance: { amount: '-5.00', currency: 'BRL' } }],
    ['three decimals', { initialBalance: { amount: '1.001', currency: 'BRL' } }],
    ['scientific notation', { initialBalance: { amount: '1e3', currency: 'BRL' } }],
    ['bad playerId', { playerId: 'not-a-uuid' }],
    ['lowercase currency', { initialBalance: { amount: '1.00', currency: 'brl' } }],
  ])('400 for %s', async (_name, override) => {
    const reply = await call('POST', '/wallets', {
      body: {
        playerId: randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
        ...override,
      },
    });

    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBeString();
  });

  test('400 for a body that is not JSON', async () => {
    const reply = await call('POST', '/wallets', { raw: '{broken' });

    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('BAD_REQUEST');
  });
});

describe('GET /wallets/:walletId', () => {
  test('200, 404 and 400', async () => {
    const wallet = await createWallet('50.00');

    const found = await call('GET', `/wallets/${wallet.walletId}`);
    expect(found.status).toBe(200);
    expect(found.json).toEqual({
      id: wallet.walletId,
      playerId: wallet.playerId,
      balance: { amount: '50.00', currency: 'BRL' },
      version: 1,
    });

    const missing = await call('GET', `/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('WALLET_NOT_FOUND');

    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  test('unknown route is a JSON 404, not a 500', async () => {
    const reply = await call('GET', '/nope');

    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  const fill = async (wallet: { walletId: string; playerId: string }, bets: number) => {
    for (let i = 0; i < bets; i += 1) {
      expect((await submit(body(wallet, 'BET', '1.00'))).status).toBe(201);
    }
  };

  test('pages ascending by sequence with an opaque cursor, last page has nextCursor null', async () => {
    const wallet = await createWallet('100.00');
    await fill(wallet, 6); // 1 opening + 6 bets = 7 entries

    const first = await call('GET', `/wallets/${wallet.walletId}/ledger?limit=3`);
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(3);
    expect(first.json.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
    });
    expect(first.json.items[0]).not.toHaveProperty('sequence');
    expect(first.json.nextCursor).toBeString();

    const second = await call(
      'GET',
      `/wallets/${wallet.walletId}/ledger?limit=3&cursor=${first.json.nextCursor}`,
    );
    const third = await call(
      'GET',
      `/wallets/${wallet.walletId}/ledger?limit=3&cursor=${second.json.nextCursor}`,
    );

    expect(second.json.items).toHaveLength(3);
    expect(third.json.items).toHaveLength(1);
    expect(third.json.nextCursor).toBeNull();

    const all = [...first.json.items, ...second.json.items, ...third.json.items];
    expect(all.map((e: { balanceAfter: { amount: string } }) => e.balanceAfter.amount)).toEqual([
      '100.00', '99.00', '98.00', '97.00', '96.00', '95.00', '94.00',
    ]);
  });

  test('an exact multiple of the limit ends with nextCursor null (no empty trailing page)', async () => {
    const wallet = await createWallet('100.00');
    await fill(wallet, 3); // 4 entries

    const first = await call('GET', `/wallets/${wallet.walletId}/ledger?limit=2`);
    const second = await call(
      'GET',
      `/wallets/${wallet.walletId}/ledger?limit=2&cursor=${first.json.nextCursor}`,
    );

    expect(second.json.items).toHaveLength(2);
    expect(second.json.nextCursor).toBeNull();
  });

  test('default limit is 50 and the maximum is 200', async () => {
    const wallet = await createWallet('100.00');

    expect((await call('GET', `/wallets/${wallet.walletId}/ledger`)).json.items).toHaveLength(1);
    expect((await call('GET', `/wallets/${wallet.walletId}/ledger?limit=200`)).status).toBe(200);
    expect((await call('GET', `/wallets/${wallet.walletId}/ledger?limit=201`)).status).toBe(400);
    expect((await call('GET', `/wallets/${wallet.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call('GET', `/wallets/${wallet.walletId}/ledger?limit=abc`)).status).toBe(400);
  });

  test('invalid cursor is 400, unknown wallet is 404', async () => {
    const wallet = await createWallet('100.00');

    const bad = await call('GET', `/wallets/${wallet.walletId}/ledger?cursor=garbage`);
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('INVALID_CURSOR');

    expect((await call('GET', `/wallets/${randomUUID()}/ledger`)).status).toBe(404);
  });

  test('entries inserted while paginating are neither repeated nor skipped', async () => {
    const wallet = await createWallet('1000.00');
    await fill(wallet, 9); // 10 entries

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const reply: Reply = await call(
        'GET',
        `/wallets/${wallet.walletId}/ledger?limit=4${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(reply.status).toBe(200);
      seen.push(...reply.json.items.map((e: { id: string }) => e.id));
      cursor = reply.json.nextCursor;
      pages += 1;

      // Concurrent writers keep appending between (and during) page reads.
      await Promise.all([
        fill(wallet, 2),
        call('GET', `/wallets/${wallet.walletId}/ledger?limit=4`),
      ]);
    } while (cursor && pages < 30);

    const final = await call('GET', `/wallets/${wallet.walletId}/ledger?limit=200`);
    const finalIds: string[] = final.json.items.map((e: { id: string }) => e.id);

    expect(new Set(seen).size).toBe(seen.length); // never repeated
    expect(seen).toEqual(finalIds.slice(0, seen.length)); // never skipped, same order
    expect(seen.length).toBeGreaterThanOrEqual(10);
  });
});

describe('POST /wagering/transactions', () => {
  test('201 for a new PROCESSED bet', async () => {
    const wallet = await createWallet('100.00');

    const reply = await submit(body(wallet, 'BET', '25.00'));

    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  test('identical retry is 200 with idempotentReplay true and the original answer', async () => {
    const wallet = await createWallet('100.00');
    const payload = body(wallet, 'BET', '25.00');

    const first = await submit(payload);
    await submit(body(wallet, 'BET', '10.00'));
    const replay = await submit(payload);

    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ...first.json, idempotentReplay: true });
    expect(replay.json.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  test('50 identical parallel requests: one 201, forty-nine 200, one debit', async () => {
    const wallet = await createWallet('100.00');
    const payload = body(wallet, 'BET', '10.00');

    const replies = await Promise.all(Array.from({ length: 50 }, () => submit(payload)));

    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(49);
    expect((await call('GET', `/wallets/${wallet.walletId}`)).json.balance.amount).toBe('90.00');
  });

  test('409 for the same key with a different payload and for a reused provider id', async () => {
    const wallet = await createWallet('100.00');
    const payload = body(wallet, 'BET', '25.00');
    await submit(payload);

    const changed = await submit({ ...payload, money: { amount: '26.00', currency: 'BRL' } });
    expect(changed.status).toBe(409);
    expect(changed.json.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const otherKey = await submit(payload, 'another-key');
    expect(otherKey.status).toBe(409);
  });

  test('400 when Idempotency-Key is missing, blank or too long', async () => {
    const wallet = await createWallet('100.00');
    const payload = body(wallet, 'BET', '25.00');

    const missing = await call('POST', '/wagering/transactions', { body: payload });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe('VALIDATION_ERROR');
    expect((await submit(payload, ' ')).status).toBe(400);
    expect((await submit(payload, 'x'.repeat(256))).status).toBe(400);
  });

  test.each([
    ['OPENING kind', { kind: 'OPENING' }],
    ['unknown field', { surprise: true }],
    ['numeric amount', { money: { amount: 25, currency: 'BRL' } }],
    ['too many decimals', { money: { amount: '25.001', currency: 'BRL' } }],
    ['zero bet', { money: { amount: '0.00', currency: 'BRL' } }],
    ['bad walletId', { walletId: 'x' }],
    ['REFUND without reference', { kind: 'REFUND' }],
  ])('400 for %s', async (_name, override) => {
    const wallet = await createWallet('100.00');

    const reply = await submit(body(wallet, 'BET', '25.00', override));

    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBeString();
  });

  test('404 when the wallet does not exist', async () => {
    const reply = await submit(
      body({ walletId: randomUUID(), playerId: randomUUID() }, 'BET', '1.00'),
    );

    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('422 with failureCode for an insufficient balance, and the replay stays 422', async () => {
    const wallet = await createWallet('30.00');
    const payload = body(wallet, 'BET', '80.00');

    const reply = await submit(payload);
    expect(reply.status).toBe(422);
    expect(reply.json).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: { amount: '30.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: 'INSUFFICIENT_BALANCE',
    });

    const replay = await submit(payload);
    expect(replay.status).toBe(422);
    expect(replay.json).toEqual({ ...reply.json, idempotentReplay: true });
  });

  test('422 for wallet/player and currency mismatches', async () => {
    const wallet = await createWallet('30.00');

    const wrongPlayer = await submit(body({ ...wallet, playerId: randomUUID() }, 'BET', '1.00'));
    expect(wrongPlayer.status).toBe(422);
    expect(wrongPlayer.json.failureCode).toBe('WALLET_PLAYER_MISMATCH');

    const wrongCurrency = await submit(
      body(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }),
    );
    expect(wrongCurrency.status).toBe(422);
    expect(wrongCurrency.json.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('two simultaneous bets of 80 on a balance of 100: one 201, one 422, balance 20', async () => {
    const wallet = await createWallet('100.00');

    const replies = await Promise.all([
      submit(body(wallet, 'BET', '80.00')),
      submit(body(wallet, 'BET', '80.00')),
    ]);

    expect(replies.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 422]);
    expect((await call('GET', `/wallets/${wallet.walletId}`)).json.balance.amount).toBe('20.00');
  });

  test('WIN, LOSS, REFUND and ROLLBACK flows', async () => {
    const wallet = await createWallet('100.00');
    const bet = body(wallet, 'BET', '30.00');
    expect((await submit(bet)).status).toBe(201);

    const win = await submit(
      body(wallet, 'WIN', '50.00', { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win.status).toBe(201);
    expect(win.json.balance.amount).toBe('120.00');

    const loss = await submit(body(wallet, 'LOSS', '0.00'));
    expect(loss.status).toBe(201);
    expect(loss.json.balance.amount).toBe('120.00');

    const refund = await submit(
      body(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund.status).toBe(201);
    expect(refund.json.balance.amount).toBe('150.00');

    const secondReversal = await submit(
      body(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(secondReversal.status).toBe(422);
    expect(secondReversal.json.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const winPayload = body(wallet, 'WIN', '10.00');
    await submit(winPayload);
    const rollback = await submit(
      body(wallet, 'ROLLBACK', '10.00', {
        referenceExternalTransactionId: winPayload.externalTransactionId,
      }),
    );
    expect(rollback.status).toBe(201);
    expect(rollback.json.balance.amount).toBe('150.00');
  });

  test('202 for a reversal before its reference, replay stays 202, then 200 once resolved', async () => {
    const wallet = await createWallet('100.00');
    const bet = body(wallet, 'BET', '30.00');
    const refundPayload = body(wallet, 'REFUND', '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const pending = await submit(refundPayload);
    expect(pending.status).toBe(202);
    expect(pending.json).toEqual({
      transactionId: expect.any(String),
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await submit(refundPayload);
    expect(replay.status).toBe(202);
    expect(replay.json.idempotentReplay).toBe(true);

    await submit(bet);
    const resolved = await ctx.resolver.execute(pending.json.transactionId);
    expect(String(resolved.status)).toBe('PROCESSED');

    const finalReplay = await submit(refundPayload);
    expect(finalReplay.status).toBe(200);
    expect(finalReplay.json.status).toBe('PROCESSED');
    expect(finalReplay.json.idempotentReplay).toBe(true);
    expect(finalReplay.json.balance.amount).toBe('100.00');
  });

  test('X-Correlation-Id is optional, echoed when valid and rejected when malformed', async () => {
    const wallet = await createWallet('100.00');

    const ok = await submit(body(wallet, 'BET', '1.00'), undefined, { 'x-correlation-id': 'trace-123' });
    expect(ok.status).toBe(201);
    expect(ok.headers.get('x-correlation-id')).toBe('trace-123');

    const bad = await submit(body(wallet, 'BET', '1.00'), undefined, { 'x-correlation-id': 'bad id!' });
    expect(bad.status).toBe(400);
  });

  test('503 with Retry-After when the wallet lock cannot be acquired, and a retry succeeds', async () => {
    const wallet = await createWallet('100.00');
    const payload = body(wallet, 'BET', '5.00');

    // A real lock held by another connection (the app uses lock_timeout=300ms).
    const holder = ctx.orm.em.fork();
    await holder.begin();

    try {
      await holder.execute(`select 1 from wallets where id = ? for update`, [wallet.walletId]);

      const reply = await submit(payload);

      expect(reply.status).toBe(503);
      expect(reply.json.error.code).toBe('TRANSIENT_INFRASTRUCTURE');
      expect(reply.headers.get('retry-after')).toBe('1');
    } finally {
      await holder.rollback();
    }

    const retry = await submit(payload);
    expect(retry.status).toBe(201);
    expect(retry.json.balance.amount).toBe('95.00');
  });
});

describe('GET /wagering/transactions/:transactionId and provider lookup', () => {
  test('200 by id and by provider identity (URL-encoded id), 404 and 400', async () => {
    const wallet = await createWallet('100.00');
    const payload = body(wallet, 'BET', '25.00', { externalTransactionId: 'weird id/with:chars' });
    const created = await submit(payload);

    const byId = await call('GET', `/wagering/transactions/${created.json.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.json).toMatchObject({
      transactionId: created.json.transactionId,
      providerId: 'provider-a',
      externalTransactionId: 'weird id/with:chars',
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
      attempts: 0,
    });

    const byExternal = await call(
      'GET',
      `/providers/provider-a/wagering/transactions/${encodeURIComponent('weird id/with:chars')}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.json.transactionId).toBe(created.json.transactionId);

    expect((await call('GET', `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', '/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
    expect((await call('GET', '/wagering/transactions/not-a-uuid')).status).toBe(400);
  });

  test('a rejected and a pending transaction expose failureCode and retry schedule', async () => {
    const wallet = await createWallet('10.00');
    const rejected = await submit(body(wallet, 'BET', '50.00'));
    const pending = await submit(
      body(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: 'later' }),
    );

    const r = await call('GET', `/wagering/transactions/${rejected.json.transactionId}`);
    expect(r.json).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' });

    const p = await call('GET', `/wagering/transactions/${pending.json.transactionId}`);
    expect(p.json).toMatchObject({
      status: 'PENDING_REFERENCE',
      attempts: 0,
      referenceExternalTransactionId: 'later',
    });
    expect(p.json.nextAttemptAt).toBeString();
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('200 consistent, then inconsistent after a direct UPDATE (never corrected)', async () => {
    const wallet = await createWallet('100.00');
    await submit(body(wallet, 'BET', '40.00'));

    const ok = await call('POST', `/wallets/${wallet.walletId}/reconciliation`);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({
      walletId: wallet.walletId,
      storedBalance: { amount: '60.00', currency: 'BRL' },
      calculatedBalance: { amount: '60.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });

    const metrics = app.get(MetricsService);
    const before = (await metrics.registry.getMetricsAsJSON())[0]?.values[0]?.value ?? 0;
    await ctx.em.execute(`update wallets set balance = 61.50 where id = ?`, [wallet.walletId]);

    const bad = await call('POST', `/wallets/${wallet.walletId}/reconciliation`);
    expect(bad.status).toBe(200);
    expect(bad.json.consistent).toBe(false);
    expect(bad.json.difference).toEqual({ amount: '1.50', currency: 'BRL' });
    expect(bad.json.storedBalance.amount).toBe('61.50');
    expect((await call('GET', `/wallets/${wallet.walletId}`)).json.balance.amount).toBe('61.50');
    const after = (await metrics.registry.getMetricsAsJSON())[0]?.values[0]?.value ?? 0;
    expect(after).toBe(before + 1);

    await ctx.em.execute(`update wallets set balance = 60.00 where id = ?`, [wallet.walletId]);
  });

  test('404 and 400', async () => {
    expect((await call('POST', `/wallets/${randomUUID()}/reconciliation`)).status).toBe(404);
    expect((await call('POST', '/wallets/x/reconciliation')).status).toBe(400);
  });
});

describe('health', () => {
  test('live is always 200', async () => {
    const reply = await call('GET', '/health/live');

    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ status: 'ok' });
  });

  test('ready is 200 when PostgreSQL and SQS answer', async () => {
    const reply = await call('GET', '/health/ready');

    expect(reply.status).toBe(200);
    expect(reply.json.status).toBe('ok');
    expect(reply.json.checks.database.status).toBe('up');
    expect(reply.json.checks.sqs.status).toBe('up');
  });

  test('ready is 503 with per-dependency detail when SQS is unreachable, live stays 200', async () => {
    const broken = await startApp((builder) =>
      builder.overrideProvider(SQS_CONFIG).useValue({
        ...sqsConfigFromEnv(),
        endpoint: 'http://127.0.0.1:9',
        queueUrl: undefined,
        requestTimeoutMs: 500,
      }),
    );

    try {
      const ready = await call('GET', '/health/ready', { url: broken.baseUrl });
      expect(ready.status).toBe(503);
      expect(ready.json.status).toBe('unavailable');
      expect(ready.json.checks.database.status).toBe('up');
      expect(ready.json.checks.sqs.status).toBe('down');
      expect(ready.json.checks.sqs.error).toBeString();

      expect((await call('GET', '/health/live', { url: broken.baseUrl })).status).toBe(200);
    } finally {
      await broken.app.close();
    }
  });
});

describe('authentication seam', () => {
  test('the identity port can be replaced; health stays public', async () => {
    const denyAll: ProviderIdentityPort = {
      authenticate: (request) =>
        Promise.resolve(request.headers['x-token'] === 'ok' ? { subject: 'provider-a' } : null),
    };
    const guarded = await startApp((builder) =>
      builder.overrideProvider(PROVIDER_IDENTITY).useValue(denyAll),
    );

    try {
      const url = guarded.baseUrl;
      const payload = { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } };

      const denied = await call('POST', '/wallets', { url, body: payload });
      expect(denied.status).toBe(401);
      expect(denied.json.error.code).toBe('UNAUTHORIZED');

      const allowed = await call('POST', '/wallets', { url, body: payload, headers: { 'x-token': 'ok' } });
      expect(allowed.status).toBe(201);

      expect((await call('GET', '/health/live', { url })).status).toBe(200);
      expect((await call('GET', '/health/ready', { url })).status).toBe(200);
    } finally {
      await guarded.app.close();
    }
  });

  test('by default (no-op port) every request is accepted', async () => {
    expect((await call('GET', `/wallets/${randomUUID()}`)).status).toBe(404);
  });
});

describe('amount capacity and /metrics', () => {
  test('amounts beyond numeric(20,2) are a 400, never a 500', async () => {
    const wallet = await createWallet('100.00');
    const tooBig = await submit(body(wallet, 'BET', '1000000000000000000.00'));

    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error.code).toBe('INVALID_MONEY');

    const bigWallet = await call('POST', '/wallets', {
      body: { playerId: randomUUID(), initialBalance: { amount: '1000000000000000000', currency: 'BRL' } },
    });

    expect(bigWallet.status).toBe(400);
  });

  test('GET /metrics is public, text/plain and counts what just happened', async () => {
    const wallet = await createWallet('100.00');
    const first = body(wallet, 'BET', '10.00');

    expect((await submit(first)).status).toBe(201);
    expect((await submit(first)).status).toBe(200);
    expect((await submit(body(wallet, 'BET', '500.00'))).status).toBe(422);

    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED",channel="http"}');
    expect(text).toContain('wager_transactions_total{kind="BET",status="REJECTED",channel="http"}');
    expect(text).toContain('idempotent_replays_total{channel="http"}');
    expect(text).toContain('wager_processing_duration_seconds_bucket');

    for (const name of [
      'idempotency_conflicts_total', 'sqs_messages_total', 'sqs_retries_total', 'sqs_dlq_total',
      'lock_conflicts_total', 'outbox_published_total', 'outbox_publish_failures_total',
      'outbox_lag_seconds', 'outbox_pending', 'wallet_reconciliation_mismatches_total',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });
});
