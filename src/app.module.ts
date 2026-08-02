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
import { DeliveryModule } from './modules/delivery/delivery.module.js'
import {
  ZodExceptionFilter,
  HttpLoggerMiddleware,
  RequestIdMiddleware,
} from './common/index.js'

const config = appConfig()

@Module({
  imports: [
    ConfigProviderModule.forRoot(config),
    DrizzleModule,
    // forRootAsync re-reads from DI to pick up cluster config that may differ per env.
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
    ObservabilityModule,
    IdempotencyModule,
    TasksModule,
    ExecutorModule,
    DeliveryModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ZodExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, HttpLoggerMiddleware).forRoutes('*')
  }
}
