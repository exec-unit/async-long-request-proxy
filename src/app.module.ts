import { Module } from '@nestjs/common'
import { appConfig } from '#src/config/index.js'
import { ConfigProviderModule } from '#src/config/index.js'
import { APP_CONFIG } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'
import { DrizzleModule } from './database/drizzle/drizzle.module.js'
import { RedisModule } from '#libs/redis/index.js'
import { QueueModule } from '#libs/queue/index.js'
import { ObservabilityModule } from '#libs/observability/index.js'

// Parse and validate all ENV vars once at module load.
// If any required var is missing, startup is aborted with a descriptive Zod error.
const config = appConfig()

@Module({
  imports: [
    ConfigProviderModule.forRoot(config),
    DrizzleModule,
    // Shared Redis client — used by idempotency, rate-limiter, and pub/sub.
    RedisModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => {
        const { host, port, password, db } = cfg.redis
        return { host, port, ...(password ? { password } : {}), db }
      },
    }),
    // BullMQ infrastructure — processors are registered in feature modules.
    QueueModule.forRoot(config.redis),
    ObservabilityModule,
  ],
})
export class AppModule {}
