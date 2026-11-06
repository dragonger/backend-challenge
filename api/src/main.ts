import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  // SIGTERM / SIGINT: onModuleDestroy hooks stop the consumer, the publisher
  // and the pending worker (draining what is in progress) BEFORE the ORM and
  // the SQS client are closed in onApplicationShutdown.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}

await bootstrap();
