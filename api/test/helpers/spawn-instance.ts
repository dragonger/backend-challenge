import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { testDatabaseName } from '../../src/infrastructure/database/mikro-orm.config.js';
import type { TestQueues } from './sqs.js';
import { waitFor } from './wait.js';

export interface InstanceOptions {
  consumer?: boolean;
  publisher?: boolean;
  pendingWorker?: boolean;
  /** TEST SEAM: the process exits right after the SQL commit, before the ack. */
  crashAfterCommit?: boolean;
  env?: Record<string, string>;
}

/** A real OS process running `bun src/main.ts` against the test database and queues. */
export class Instance {
  private constructor(
    readonly port: number,
    private readonly process: Bun.Subprocess,
  ) {}

  static async start(queues: TestQueues, options: InstanceOptions = {}): Promise<Instance> {
    const port = await freePort();
    const child = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        ...process.env,
        ...queues.env(),
        NODE_ENV: 'test',
        PORT: String(port),
        DB_NAME: testDatabaseName(),
        DB_POOL_MAX: '10',
        LOCK_TIMEOUT_MS: '10000',
        LOG_LEVEL: 'silent',
        SQS_CONSUMER_ENABLED: String(options.consumer ?? true),
        OUTBOX_PUBLISHER_ENABLED: String(options.publisher ?? false),
        PENDING_WORKER_ENABLED: String(options.pendingWorker ?? false),
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_CONSUMER_CONCURRENCY: '10',
        SQS_RETRY_BASE_SECONDS: '1',
        SQS_RETRY_MAX_SECONDS: '4',
        OUTBOX_POLL_INTERVAL_MS: '100',
        OUTBOX_GAUGE_INTERVAL_MS: '500',
        PENDING_WORKER_INTERVAL_MS: '200',
        PENDING_REFERENCE_INITIAL_BACKOFF_MS: '200',
        ...(options.crashAfterCommit ? { TEST_CRASH_AFTER_COMMIT: '1' } : {}),
        ...options.env,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const instance = new Instance(port, child);

    await waitFor(
      `instance on port ${port} ready`,
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`instance exited early with code ${child.exitCode}`);
        }

        const response = await fetch(`${instance.baseUrl}/health/ready`).catch(() => undefined);
        return response?.status === 200;
      },
      45_000,
      250,
    );

    return instance;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get exited(): Promise<number> {
    return this.process.exited;
  }

  get exitCode(): number | null {
    return this.process.exitCode;
  }

  /** Abrupt death (no graceful shutdown), like a crash or `kill -9`. */
  async kill(): Promise<void> {
    if (this.process.exitCode === null) {
      this.process.kill();
    }

    await this.process.exited;
  }

  /** Current value of a Prometheus sample, summed over matching label sets. */
  async metric(name: string, labels: Record<string, string> = {}): Promise<number> {
    const text = await (await fetch(`${this.baseUrl}/metrics`)).text();
    let total = 0;

    for (const line of text.split('\n')) {
      if (!line.startsWith(name) || line.startsWith('#')) {
        continue;
      }

      const match = /^([a-zA-Z0-9_:]+)(\{([^}]*)\})?\s+(\S+)$/.exec(line);

      if (!match || match[1] !== name) {
        continue;
      }

      const present = match[3] ?? '';

      if (Object.entries(labels).every(([key, value]) => present.includes(`${key}="${value}"`))) {
        total += Number(match[4]);
      }
    }

    return total;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('no port'));
        }
      });
    });
  });
}
