/**
 * `bun run test:load`: load test of POST /wagering/transactions with k6
 * (grafana/k6 through docker, nothing installed on the host).
 *
 * What it does:
 *  1. prepares the TEST database (migrations + truncate) and a throw-away
 *     FIFO events queue;
 *  2. starts LOAD_INSTANCES real app processes (HTTP + outbox publisher);
 *  3. runs the k6 scenarios (distinct wallets, then one hot wallet) against
 *     all instances, sampling /metrics every second (outbox lag, pending);
 *  4. waits for the outbox to drain and checks the financial invariants in SQL;
 *  5. prints (and saves to load/.out/result.json) throughput, p50/p95/p99,
 *     error rate, lock conflicts and outbox lag.
 *
 * Knobs (environment): LOAD_INSTANCES=3 LOAD_VUS=32 LOAD_DURATION_S=30
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import { buildMikroOrmConfig, testDatabaseName } from '../src/infrastructure/database/mikro-orm.config.js';
import { sqsConfigFromEnv } from '../src/infrastructure/sqs/sqs.config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = `${root}load/.out`;
const instancesCount = Number(process.env.LOAD_INSTANCES ?? 3);
const vus = Number(process.env.LOAD_VUS ?? 32);
const durationS = Number(process.env.LOAD_DURATION_S ?? 30);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- database
const dbName = testDatabaseName();
const orm = await MikroORM.init(buildMikroOrmConfig({ dbName, poolMax: 4, silentMigrations: true }));

await orm.schema.ensureDatabase();
await orm.migrator.up();
await orm.em.execute(
  `truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets restart identity cascade`,
);

// ------------------------------------------------------------------- queue
const sqsConfig = sqsConfigFromEnv();
const sqs = new SQSClient({
  region: sqsConfig.region,
  ...(sqsConfig.endpoint ? { endpoint: sqsConfig.endpoint } : {}),
  ...(sqsConfig.credentials ? { credentials: sqsConfig.credentials } : {}),
});
const eventsQueue = `load-events-${Date.now().toString(36)}.fifo`;
const { QueueUrl: eventsUrl } = await sqs.send(
  new CreateQueueCommand({
    QueueName: eventsQueue,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }),
);

// --------------------------------------------------------------- instances
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();

      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });

const children: Array<{ port: number; process: Bun.Subprocess }> = [];

for (let i = 0; i < instancesCount; i += 1) {
  const port = await freePort();

  children.push({
    port,
    process: Bun.spawn(['bun', 'src/main.ts'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        DB_NAME: dbName,
        DB_POOL_MAX: '20',
        LOG_LEVEL: 'warn',
        SQS_EVENTS_QUEUE_NAME: eventsQueue,
        SQS_CONSUMER_ENABLED: 'false',
        PENDING_WORKER_ENABLED: 'false',
        OUTBOX_PUBLISHER_ENABLED: 'true',
        OUTBOX_POLL_INTERVAL_MS: '200',
        OUTBOX_GAUGE_INTERVAL_MS: '1000',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  });
}

const stopAll = async (): Promise<void> => {
  for (const child of children) {
    if (child.process.exitCode === null) {
      child.process.kill();
    }
  }

  await Promise.allSettled(children.map((child) => child.process.exited));
};

process.on('SIGINT', () => void stopAll().then(() => process.exit(130)));

try {
  for (const child of children) {
    for (let attempt = 0; ; attempt += 1) {
      const ready = await fetch(`http://127.0.0.1:${child.port}/health/ready`).then((r) => r.status === 200, () => false);

      if (ready) {
        break;
      }

      if (attempt > 120) {
        throw new Error(`instance on port ${child.port} did not become ready`);
      }

      await sleep(500);
    }
  }

  // ---------------------------------------------------------- metrics sampler
  const scrape = async (port: number): Promise<Map<string, number>> => {
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5000) })).text();
    const values = new Map<string, number>();

    for (const line of text.split('\n')) {
      const match = /^([a-zA-Z0-9_:]+(?:\{[^}]*\})?)\s+(\S+)$/.exec(line);

      if (match) {
        values.set(match[1]!, Number(match[2]));
      }
    }

    return values;
  };
  const sum = (maps: Array<Map<string, number>>, name: string, labelPart = ''): number =>
    maps.reduce(
      (total, map) =>
        total +
        [...map].filter(([key]) => key.startsWith(name) && key.includes(labelPart)).reduce((acc, [, v]) => acc + v, 0),
      0,
    );

  const samples: Array<{ t: number; lag: number; pending: number }> = [];
  let sampling = true;
  const startedAt = Date.now();
  const sampler = (async () => {
    while (sampling) {
      const maps = await Promise.all(children.map((child) => scrape(child.port))).catch((error: unknown) => {
        console.error(`metrics sampling failed: ${String(error)}`);
        return [];
      });

      if (maps.length > 0) {
        samples.push({
          t: (Date.now() - startedAt) / 1000,
          lag: Math.max(...maps.map((m) => m.get('outbox_lag_seconds') ?? 0)),
          pending: Math.max(...maps.map((m) => m.get('outbox_pending') ?? 0)),
        });
      }

      await sleep(1000);
    }
  })();

  // --------------------------------------------------------------------- k6
  const baseUrls = children.map((child) => `http://host.docker.internal:${child.port}`).join(',');
  const k6Process = Bun.spawn(
    [
      'docker',
      'run', '--rm',
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${root}load/k6:/scripts:ro`,
      '-v', `${outDir}:/out`,
      '-e', `BASE_URLS=${baseUrls}`,
      '-e', `VUS=${vus}`,
      '-e', `DURATION_S=${durationS}`,
      'grafana/k6:latest', 'run', '--quiet',
      '--summary-export=/out/k6-summary.json',
      '/scripts/wagering.js',
    ],
    { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
  );
  // Async (not spawnSync): the metrics sampler must keep running during the load.
  const k6 = { status: await k6Process.exited };

  // ---------------------------------------------------- drain and invariants
  let drainedAt: number | undefined;
  const k6End = Date.now();

  for (let attempt = 0; attempt < 240; attempt += 1) {
    const [{ n }] = await orm.em.execute<Array<{ n: string }>>(`select count(*)::text as n from outbox_messages where published_at is null`);

    if (Number(n) === 0) {
      drainedAt = Date.now();
      break;
    }

    await sleep(500);
  }

  sampling = false;
  await sampler;

  const maps = await Promise.all(children.map((child) => scrape(child.port)));
  const rows = async <T>(sql: string): Promise<T[]> => orm.em.execute<T[]>(sql);
  const [counts] = await rows<{ wallets: string; bets: string; processed: string; ledger: string; outbox: string; unpublished: string }>(
    `select (select count(*) from wallets)::text as wallets,
            (select count(*) from wager_transactions where kind = 'BET')::text as bets,
            (select count(*) from wager_transactions where kind = 'BET' and status = 'PROCESSED')::text as processed,
            (select count(*) from wallet_ledger_entries where direction = 'DEBIT')::text as ledger,
            (select count(*) from outbox_messages)::text as outbox,
            (select count(*) from outbox_messages where published_at is null)::text as unpublished`,
  );
  const mismatches = await rows<{ id: string }>(
    `select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      group by w.id, w.balance
     having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) or w.balance < 0`,
  );

  // ------------------------------------------------------------------ report
  const summary = JSON.parse(readFileSync(`${outDir}/k6-summary.json`, 'utf8')) as {
    metrics: Record<string, Record<string, number> & { values?: Record<string, number> }>;
  };
  const metric = (name: string): Record<string, number> => {
    const raw = summary.metrics[name];

    return raw ? (raw.values ?? raw) : {};
  };
  const scenario = (name: 'distinct_wallets' | 'hot_wallet') => {
    const duration = metric(`http_req_duration{scenario:${name}}`);
    const reqs = metric(`http_reqs{scenario:${name}}`);
    const failed = metric(`http_req_failed{scenario:${name}}`);

    return {
      requests: reqs.count,
      // k6's own rate divides by the whole test time (both scenarios + gap).
      throughputRps: Number(((reqs.count ?? 0) / durationS).toFixed(1)),
      p50ms: Number((duration.med ?? 0).toFixed(1)),
      p95ms: Number((duration['p(95)'] ?? 0).toFixed(1)),
      p99ms: Number((duration['p(99)'] ?? 0).toFixed(1)),
      maxMs: Number((duration.max ?? 0).toFixed(1)),
      errorRate: Number(((failed.rate ?? failed.value ?? 0) * 100).toFixed(2)),
    };
  };
  const processingCount = sum(maps, 'wager_processing_duration_seconds_count');
  const processingSum = sum(maps, 'wager_processing_duration_seconds_sum');
  const result = {
    environment: {
      instances: instancesCount,
      vusPerScenario: vus,
      durationSecondsPerScenario: durationS,
      node: `bun ${Bun.version}`,
      platform: process.platform,
    },
    distinct_wallets: scenario('distinct_wallets'),
    hot_wallet: scenario('hot_wallet'),
    server: {
      lockConflicts: sum(maps, 'lock_conflicts_total'),
      idempotentReplays: sum(maps, 'idempotent_replays_total'),
      avgProcessingMs: processingCount > 0 ? Number(((processingSum / processingCount) * 1000).toFixed(1)) : 0,
      outboxPublished: sum(maps, 'outbox_published_total'),
      outboxPublishFailures: sum(maps, 'outbox_publish_failures_total'),
    },
    outbox: {
      maxLagSeconds: Number(Math.max(0, ...samples.map((s) => s.lag)).toFixed(1)),
      maxPending: Math.max(0, ...samples.map((s) => s.pending)),
      samplesPerSecond: samples.map((s) => `${s.t.toFixed(0)}s lag=${s.lag.toFixed(2)} pending=${s.pending}`),
      drainSecondsAfterLoad: drainedAt ? Number(((drainedAt - k6End) / 1000).toFixed(1)) : null,
      rows: Number(counts?.outbox),
      unpublishedAtEnd: Number(counts?.unpublished),
    },
    invariants: {
      walletsWithBalanceDifferentFromLedger: mismatches.length,
      betsStored: Number(counts?.bets),
      betsProcessed: Number(counts?.processed),
      ledgerDebits: Number(counts?.ledger),
      ledgerDebitsEqualProcessedBets: counts?.processed === counts?.ledger,
    },
    k6ExitCode: k6.status,
  };

  writeFileSync(`${outDir}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  if (mismatches.length > 0 || counts?.processed !== counts?.ledger || k6.status !== 0) {
    process.exitCode = 1;
  }
} finally {
  await stopAll();
  await sqs.send(new DeleteQueueCommand({ QueueUrl: eventsUrl })).catch(() => undefined);
  sqs.destroy();
  await orm.close(true);
}
