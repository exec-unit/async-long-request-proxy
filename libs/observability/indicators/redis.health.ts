import { Injectable } from '@nestjs/common'
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus'
import { RedisService } from '#libs/redis/redis.service.js'

/** Used by the readiness probe to verify the Redis instance is reachable. */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly redis: RedisService,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('redis')
    let timerId: ReturnType<typeof setTimeout> | undefined

    try {
      // Prevent a hung Redis connection from blocking the readiness probe indefinitely.
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new Error('Redis check timed out after 2s'))
        }, 2000)
      })

      await Promise.race([this.redis.client.ping(), timeoutPromise])

      return indicator.up()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return indicator.down({ message })
    } finally {
      clearTimeout(timerId)
    }
  }
}
