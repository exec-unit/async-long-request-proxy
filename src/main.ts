import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { AppLogger } from '#libs/logger/index.js'
import { appConfig } from './config/index.js'

async function bootstrap() {
  // Initialize standalone logger instance for NestJS context
  const appLogger = new AppLogger()

  const app = await NestFactory.create(AppModule, {
    logger: appLogger,
  })

  // Basic CORS for SSE and web clients (can be adjusted via config if needed)
  app.enableCors({
    origin: '*',
    credentials: true,
  })

  // Required for BullMQ and postgres.js to drain connections gracefully on SIGTERM.
  app.enableShutdownHooks()

  const { port, env } = appConfig().app
  await app.listen(port, '0.0.0.0')

  appLogger.log(`Proxy API running in [${env}] mode on port ${String(port)}`, 'Bootstrap')
}

void bootstrap()
