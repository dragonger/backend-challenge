import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { intFromEnv } from '../../config/env.js';
import { SqsService } from '../sqs/sqs.service.js';

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { database: DependencyStatus; sqs: DependencyStatus };
}

const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Readiness = PostgreSQL answers `select 1` AND the main SQS queue is reachable. */
@Injectable()
export class ReadinessService {
  private readonly timeoutMs = intFromEnv('READINESS_TIMEOUT_MS', 2000);

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([
      this.probe('database', () => this.em.fork().execute('select 1')),
      this.probe('sqs', () => this.sqs.probeMainQueue()),
    ]);

    return {
      status: database.status === 'up' && sqs.status === 'up' ? 'ok' : 'unavailable',
      checks: { database, sqs },
    };
  }

  private async probe(
    label: string,
    work: () => Promise<unknown>,
  ): Promise<DependencyStatus> {
    const started = performance.now();

    try {
      await withTimeout(work(), this.timeoutMs, label);

      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
      };
    }
  }
}
