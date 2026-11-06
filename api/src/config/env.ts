/** Small helpers to read typed settings from process.env with safe defaults. */

export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === '' ? fallback : Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
}

export function stringFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function optionalStringFromEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

/** Boolean flag: "true"/"1" and "false"/"0" (case-insensitive); anything else throws. */
export function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (raw === 'true' || raw === '1') {
    return true;
  }

  if (raw === 'false' || raw === '0') {
    return false;
  }

  throw new Error(`Invalid boolean environment variable: ${name}`);
}

/**
 * Background workers (SQS consumer, outbox publisher, pending worker) are on
 * by default, except under tests, which opt in explicitly.
 */
export function backgroundWorkerDefault(): boolean {
  return process.env.NODE_ENV !== 'test';
}
