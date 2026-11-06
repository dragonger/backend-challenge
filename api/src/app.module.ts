import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { LoggerModule } from 'nestjs-pino';

import mikroOrmConfig from './infrastructure/database/mikro-orm.config.js';
import { contextMiddleware } from './infrastructure/observability/context.middleware.js';
import { loggerParams } from './infrastructure/observability/logger.config.js';
import { HttpModule } from './interfaces/http/http.module.js';
import { WorkersModule } from './workers.module.js';

@Module({
  imports: [
    LoggerModule.forRoot(loggerParams()),
    MikroOrmModule.forRoot(mikroOrmConfig),
    HttpModule,
    WorkersModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Opens the AsyncLocalStorage scope (correlationId, ...) of each request.
    // The root module's middleware is registered before the one of
    // LoggerModule (pino-http), and after the body parser (which would
    // otherwise lose the async context), so the access log sees the context.
    consumer.apply(contextMiddleware).forRoutes('*');
  }
}
