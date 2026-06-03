import { EnvSchema } from './env.schema.js'
import type { Env } from './env.schema.js'

export interface AppConfig {
  app: {
    env: Env['NODE_ENV']
    port: number
  }
  database: {
    url: string
  }
  redis: {
    host: string
    port: number
    password: string | undefined
    db: number
  }
  rateLimit: {
    enabled: boolean
    capacity: number
  }
}

/**
 * Parses and validates process.env via EnvSchema.
 * Throws with a full issue list if any variable is missing or malformed.
 * Called once at module load time in AppModule — result passed to ConfigProviderModule.
 */
export function appConfig(): AppConfig {
  // Load .env file natively in Node.js >= 20.12.0
  // We ignore the error if the file doesn't exist (e.g. in production)
  try {
    process.loadEnvFile()
  } catch {
    // No .env present — expected in containerised environments
  }

  const env = EnvSchema.parse(process.env)
  return {
    app: {
      env: env.NODE_ENV,
      port: env.PORT,
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
    },
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED,
      capacity: env.RATE_LIMIT_CAPACITY,
    },
  }
}
