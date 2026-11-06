import { Controller, Get, Header } from '@nestjs/common';

import { MetricsService } from '../../../infrastructure/metrics/metrics.service.js';
import { Public } from '../auth/public.decorator.js';

/** Prometheus scrape endpoint. Public like the health checks. */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
