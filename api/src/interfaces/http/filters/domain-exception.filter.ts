import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';

import { mapExceptionToHttp } from './http-error-mapper.js';

/** Global filter (registered via APP_FILTER): catches EVERYTHING. */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapExceptionToHttp(exception);

    if (mapped.unexpected) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    } else if (mapped.status === 503) {
      this.logger.warn(mapped.body.error.code);
    }

    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }

    response.status(mapped.status).json(mapped.body);
  }
}
