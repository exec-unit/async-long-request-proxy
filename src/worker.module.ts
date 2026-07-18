import { Module } from '@nestjs/common'
import { appConfig } from '#src/config/index.js'
import { ConfigProviderModule } from '#src/config/index.js'
import { APP_CONFIG } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'
import { DrizzleModule } from './database/drizzle/drizzle.module.js'
import { RedisModule } from '#libs/redis/index.js'
import { QueueModule } from '#libs/queue/index.js'
import { HttpRetryModule } from '#libs/http-retry/index.js'
import { ExecutorWorkerModule } from './modules/executor/executor-worker.module.js'

const config = appConfig()

/**
 * Standalone NestJS application context for the background worker process.
 * No HTTP server is started - only BullMQ consumers and their dependencies.
 */
@Module({
  imports: [
    ConfigProviderModule.forRoot(config),
    DrizzleModule,
    RedisModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => {
        const { host, port, password, db, clusterMode, clusterNodes } = cfg.redis
        return {
          host,
          port,
          ...(password ? { password } : {}),
          db,
          clusterMode,
          ...(clusterNodes ? { clusterNodes } : {}),
        }
      },
    }),
    QueueModule.forRoot(config.redis),
    HttpRetryModule,
    ExecutorWorkerModule,
  ],
})
export class WorkerModule {}
