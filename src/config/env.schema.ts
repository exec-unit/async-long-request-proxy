import { z } from 'zod'

/**
 * Source of truth for all environment variables consumed by the proxy.
 * Validated once at bootstrap - a missing or malformed variable aborts startup
 * with a descriptive error rather than a runtime crash deep in the call stack.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    PORT: z.coerce.number().int().positive().default(8080),

    DATABASE_URL: z
      .string()
      .regex(
        /^postgre(?:s|sql):\/\/.+/i,
        'DATABASE_URL must start with postgres:// or postgresql://',
      ),

    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.coerce.number().int().min(0).default(0),

    REDIS_CLUSTER_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    REDIS_CLUSTER_NODES: z.string().optional(),

    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(1000),

    DATA_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    TIMEOUT_SWEEPER_CRON: z.string().default('* * * * *'),
    DATA_RETENTION_CRON: z.string().default('0 3 * * *'),
  })
  .superRefine((data, ctx) => {
    // Cross-field validation: cluster mode requires node list at startup, not at connection time.
    if (data.REDIS_CLUSTER_MODE && !data.REDIS_CLUSTER_NODES) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_CLUSTER_NODES'],
        message: 'REDIS_CLUSTER_NODES is required when REDIS_CLUSTER_MODE=true',
      })
    }
  })

export type Env = z.infer<typeof EnvSchema>
