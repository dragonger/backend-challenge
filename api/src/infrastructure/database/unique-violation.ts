import { UniqueConstraintViolationException } from '@mikro-orm/core';

interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

const asPg = (error: unknown): PgLikeError | undefined =>
  error !== null && typeof error === 'object'
    ? (error as PgLikeError)
    : undefined;

/** True for PostgreSQL SQLSTATE 23505 (unique_violation). */
export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof UniqueConstraintViolationException) {
    return true;
  }

  const pg = asPg(error);
  return pg?.code === '23505' || asPg(pg?.cause)?.code === '23505';
}

export function violatedConstraint(error: unknown): string | undefined {
  const pg = asPg(error);
  return pg?.constraint ?? asPg(pg?.cause)?.constraint;
}
