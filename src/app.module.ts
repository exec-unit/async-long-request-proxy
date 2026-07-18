import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { appConfig } from '#src/config/index.js'
import { ConfigProviderModule } from '#src/config/index.js'
import { APP_CONFIG } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'
import { DrizzleModule } from './database/drizzle/drizzle.module.js'
import { RedisModule } from '#libs/redis/index.js'
import { QueueModule } from '#libs/queue/index.js'
import { ObservabilityModule } from '#libs/observability/index.js'
import { IdempotencyModule } from '#libs/idempotency/index.js'
import { TasksModule } from './modules/tasks/tasks.module.js'
import { ExecutorModule } from './modules/executor/executor.module.js'
import {
  ZodExceptionFilter,
  HttpLoggerMiddleware,
  RequestIdMiddleware,
} from './common/index.js'

// If any required env var is missing, startup is aborted with a Zod error.
const config = appConfig()

@Module({
  imports: [
    ConfigProviderModule.forRoot(config),
    DrizzleModule,
    // Shared Redis client - used by idempotency, rate-limiter, and pub/sub.
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
    // BullMQ infrastructure - processors are registered in feature modules.
    QueueModule.forRoot(config.redis),
    ObservabilityModule,
    IdempotencyModule,
    TasksModule,
    ExecutorModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ZodExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, HttpLoggerMiddleware).forRoutes('*')
  }
}
