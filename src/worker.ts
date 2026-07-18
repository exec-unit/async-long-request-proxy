import { NestFactory } from '@nestjs/core'
import { WorkerModule } from './worker.module.js'
import { AppLogger } from '#libs/logger/index.js'

async function bootstrap(): Promise<void> {
  const logger = new AppLogger()

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger,
  })

  // Registers SIGTERM/SIGINT handlers for graceful BullMQ drain on k8s pod eviction
  app.enableShutdownHooks()

  logger.log('Worker process ready', 'Worker')
}

bootstrap().catch((err: unknown) => {
  console.error('[Worker] Bootstrap failed:', err)
  process.exit(1)
})
