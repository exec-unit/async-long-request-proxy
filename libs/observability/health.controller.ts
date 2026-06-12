import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus'
import { PostgresHealthIndicator } from './indicators/postgres.health.js'
import { RedisHealthIndicator } from './indicators/redis.health.js'

/** Exposes probes for container orchestration. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Fast, stateless check for kubelet liveness probes.
   * If this fails, the container is completely unresponsive and needs a SIGTERM.
   */
  @Get('live')
  live(): HealthCheckResult {
    return {
      status: 'ok',
      info: {},
      error: {},
      details: {},
    }
  }

  /**
   * Deep infrastructure check for kubelet readiness probes.
   * Removing a pod from the service endpoints is preferable to returning 5xx to clients.
   */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.postgres.isHealthy(),
      () => this.redis.isHealthy(),
    ])
  }
}
