import { Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { AppLogger } from '#libs/logger/index.js'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'
import type { AppConfig } from '#src/config/index.js'

/** Convenience type alias - import in repositories instead of repeating the generic. */
export type DrizzleDb = PostgresJsDatabase<typeof schema>

/**
 * Manages the postgres.js connection pool and exposes the Drizzle ORM client.
 * Lifecycle: connect() is called once by DrizzleProvider at bootstrap;
 * the pool is drained gracefully on SIGTERM via onApplicationShutdown().
 */
@Injectable()
export class DrizzleService implements OnApplicationShutdown {
  private readonly logger = new AppLogger(DrizzleService.name)
  private sql!: postgres.Sql
  private _db!: DrizzleDb

  /** Returns the initialized Drizzle client. Throws if connect() has not been called. */
  getDb(): DrizzleDb {
    return this._db
  }

  async connect(config: AppConfig): Promise<void> {
    this.sql = postgres(config.database.url, { max: 10, idle_timeout: 20 })

    try {
      const t = Date.now()
      await this.sql`SELECT 1`
      this.logger.log(`PostgreSQL connected in ${(Date.now() - t).toString()}ms`)
    } catch (error) {
      this.logger.error('Failed to connect to PostgreSQL', error)
      throw error
    }

    this._db = drizzle(this.sql, { schema })
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sql.end({ timeout: 0 })
    this.logger.log('PostgreSQL connection pool closed')
  }
}
