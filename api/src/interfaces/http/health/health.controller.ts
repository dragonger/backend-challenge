import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import {
  ReadinessService,
  type ReadinessReport,
} from '../../../infrastructure/health/readiness.service.js';
import { Public } from '../auth/public.decorator.js';

/** Health endpoints are open: no authentication (README section 2). */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Process is up. No dependency is touched. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** 200 when PostgreSQL and SQS answer, 503 with per-dependency detail otherwise. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();

    response.status(report.status === 'ok' ? 200 : 503);

    return report;
  }
}
