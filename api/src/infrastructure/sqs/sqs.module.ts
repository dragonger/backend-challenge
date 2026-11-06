import { Module } from '@nestjs/common';

import { SQS_CONFIG, sqsConfigFromEnv } from './sqs.config.js';
import { SqsService } from './sqs.service.js';

/** Reusable SQS wiring (client + config). Stage 3 consumers import it too. */
@Module({
  providers: [{ provide: SQS_CONFIG, useFactory: sqsConfigFromEnv }, SqsService],
  exports: [SQS_CONFIG, SqsService],
})
export class SqsModule {}
