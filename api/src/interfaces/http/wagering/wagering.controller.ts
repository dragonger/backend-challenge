import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { GetWagerTransaction } from '../../../application/wagering/get-wager-transaction.usecase.js';
import { ProcessWagerTransaction } from '../../../application/wagering/process-wager-transaction.usecase.js';
import {
  correlationIdSchema,
  idempotencyKeySchema,
  transactionIdParamSchema,
} from '../dto/common.js';
import {
  externalTransactionIdParamSchema,
  providerIdParamSchema,
  submitTransactionSchema,
  type SubmitTransactionDto,
} from '../dto/wager.dto.js';
import { ZodValidationPipe } from '../validation/zod.pipe.js';
import { statusForResult } from './result-status.js';

const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema);
const correlationIdPipe = new ZodValidationPipe(correlationIdSchema);

@Controller()
export class WageringController {
  constructor(
    private readonly processor: ProcessWagerTransaction,
    private readonly transactions: GetWagerTransaction,
  ) {}

  /**
   * Submits an operation. The Idempotency-Key header is mandatory and is the
   * source of truth for deduplication. Status codes: see result-status.ts and
   * the exception filter (400, 409, 503).
   */
  @Post('wagering/transactions')
  async submit(
    @Headers() headers: Record<string, string | undefined>,
    @Body(new ZodValidationPipe(submitTransactionSchema)) body: SubmitTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(headers['idempotency-key']);
    const correlationId = correlationIdPipe.transform(headers['x-correlation-id']);
    const result = await this.processor.execute({
      ...body,
      idempotencyKey,
      ...(correlationId ? { correlationId } : {}),
    });

    if (correlationId) {
      response.setHeader('X-Correlation-Id', correlationId);
    }

    response.status(statusForResult(result));

    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(
    @Param('transactionId', new ZodValidationPipe(transactionIdParamSchema))
    transactionId: string,
  ) {
    return this.transactions.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId', new ZodValidationPipe(providerIdParamSchema))
    providerId: string,
    @Param('externalTransactionId', new ZodValidationPipe(externalTransactionIdParamSchema))
    externalTransactionId: string,
  ) {
    return this.transactions.byExternalId(providerId, externalTransactionId);
  }
}
