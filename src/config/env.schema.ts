import { z } from 'zod'

/**
 * Source of truth for all environment variables consumed by the proxy.
 * Validated once at bootstrap — a missing or malformed variable aborts startup
 * with a descriptive error rather than a runtime crash deep in the call stack.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(8080),

  DATABASE_URL: z.url(),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(1000),
})

export type Env = z.infer<typeof EnvSchema>
