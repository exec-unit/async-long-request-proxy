import { NestFactory } from '@nestjs/core'
import { VersioningType } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'
import { AppLogger } from '#libs/logger/index.js'
import { appConfig } from './config/index.js'

import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { TasksModule } from './modules/tasks/tasks.module.js'
import { ExecutorModule } from './modules/executor/executor.module.js'

async function bootstrap() {
  const appLogger = new AppLogger()

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: appLogger,
  })

  // Required when running behind a reverse proxy (nginx/ALB):
  // trusts the first hop's X-Forwarded-* headers.
  app.set('trust proxy', 1)

  app.enableCors({
    origin: '*',
  })

  // Required for BullMQ and postgres.js to drain connections gracefully on SIGTERM.
  app.enableShutdownHooks()

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  })

  const { port, env } = appConfig().app
  if (env !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Async Long Request Proxy')
      .setDescription('API for queuing and managing long-running asynchronous tasks')
      .setVersion('1.0')
      .build()

    const document = SwaggerModule.createDocument(app, swaggerConfig, {
      include: [TasksModule, ExecutorModule],
    })
    SwaggerModule.setup('api/docs', app, document)
  }

  await app.listen(port, '0.0.0.0')

  appLogger.log(`Proxy API running in [${env}] mode on port ${String(port)}`, 'Bootstrap')
}

void bootstrap()
