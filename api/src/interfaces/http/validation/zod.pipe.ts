import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Invalid request (body, query, params or headers). Mapped to HTTP 400. */
export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly issues: ValidationIssue[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
  }
}

/**
 * Validates a value against a zod schema. Schemas are strict (unknown keys are
 * rejected) and do no coercion: an amount sent as a number is an error, never
 * silently converted.
 */
export class ZodValidationPipe<S extends z.ZodType>
  implements PipeTransform<unknown, z.output<S>>
{
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new RequestValidationError(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    return result.data;
  }
}
