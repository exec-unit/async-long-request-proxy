import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { PrometheusModule } from '@willsoto/nestjs-prometheus'
import { HealthController } from './health.controller.js'
import { MetricsController } from './metrics.controller.js'
import { PostgresHealthIndicator } from './indicators/postgres.health.js'
import { RedisHealthIndicator } from './indicators/redis.health.js'

/** Self-contained observability module. */
@Module({
  imports: [
    TerminusModule,
    PrometheusModule.register({
      path: 'metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
  controllers: [HealthController, MetricsController],
  providers: [PostgresHealthIndicator, RedisHealthIndicator],
})
export class ObservabilityModule {}
