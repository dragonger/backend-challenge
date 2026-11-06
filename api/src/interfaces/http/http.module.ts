import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { PROVIDER_IDENTITY } from '../../application/ports/provider-identity.port.js';
import { ReadinessService } from '../../infrastructure/health/readiness.service.js';
import { SqsModule } from '../../infrastructure/sqs/sqs.module.js';
import { WageringModule } from '../../wagering.module.js';
import { AnonymousProviderIdentity } from './auth/anonymous-provider-identity.js';
import { AuthGuard } from './auth/auth.guard.js';
import { DomainExceptionFilter } from './filters/domain-exception.filter.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { WageringController } from './wagering/wagering.controller.js';
import { WalletsController } from './wallets/wallets.controller.js';

/**
 * HTTP surface: controllers, the global exception filter and the global auth
 * guard. Needs a MikroORM root (MikroOrmModule.forRoot) in the host module.
 */
@Module({
  imports: [WageringModule, SqsModule],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    ReadinessService,
    // Authentication seam: swap this provider for a real IdP adapter.
    { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class HttpModule {}
