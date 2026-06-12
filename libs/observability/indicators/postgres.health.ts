import { Injectable } from '@nestjs/common'
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus'
import { DrizzleService } from '#src/database/drizzle/drizzle.service.js'
import { sql } from 'drizzle-orm'

/** Used by the readiness probe to verify the primary PostgreSQL instance is reachable. */
@Injectable()
export class PostgresHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly drizzle: DrizzleService,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('postgres')
    let timerId: ReturnType<typeof setTimeout> | undefined

    try {
      // Prevent a hung DB connection from blocking the readiness probe indefinitely.
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new Error('PostgreSQL check timed out after 2s'))
        }, 2000)
      })

      await Promise.race([this.drizzle.db.execute(sql`SELECT 1`), timeoutPromise])

      return indicator.up()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return indicator.down({ message })
    } finally {
      clearTimeout(timerId)
    }
  }
}
