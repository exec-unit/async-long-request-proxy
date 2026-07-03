import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** All valid task lifecycle states - mirrored by a DB CHECK constraint. */
export const TASK_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

// ---------------------------------------------------------------------------
// Column-level types
// ---------------------------------------------------------------------------

/** Opaque client payload forwarded to the executor verbatim. */
export type TaskPayload = Record<string, unknown>

/** Structured error stored when a task transitions to FAILED. */
export interface TaskError {
  /** Machine-readable code from the executor (e.g. "TIMEOUT", "INVALID_INPUT"). */
  code: string
  message: string
  details?: unknown
}

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Allows exactly-once creation semantics from clients (idempotency key)
    idempotencyKey: text('idempotency_key'),

    status: text('status').notNull().default('PENDING').$type<TaskStatus>(),

    /** Worker routing key. Determines which BullMQ processor handles the task. */
    type: text('type').notNull(),

    /** Opaque client payload. Forwarded verbatim to the executor. */
    payload: jsonb('payload').notNull().default({}).$type<TaskPayload>(),

    /** First leg of Double 202: where the worker sends the task. */
    executorUrl: text('executor_url').notNull(),

    /** Second leg of Double 202: token required from executor to push results. */
    callbackToken: text('callback_token'),

    /** Optional endpoint called when the task completes (Push Delivery). */
    webhookUrl: text('webhook_url'),

    /** Optional endpoint called when the task is cancelled (Push Cancellation). */
    cancelUrl: text('cancel_url'),

    /** Result data provided by the executor upon completion. */
    result: jsonb('result').$type<Record<string, unknown>>(),

    /** Error details provided by the executor upon failure. */
    error: jsonb('error').$type<TaskError>(),

    progress: integer('progress').notNull().default(0),

    /** Time budget (seconds). Used by the sweeper to fail orphaned tasks. */
    timeoutSeconds: integer('timeout_seconds').notNull().default(300),

    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),

    /**
     * Absolute deadline set by the worker when transitioning to PROCESSING.
     * Computed as `processingStartedAt + timeoutSeconds` in application code
     * to avoid PostgreSQL's IMMUTABLE constraint on generated timestamp arithmetic.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    completedAt: timestamp('completed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('tasks_status_idx').on(t.status),
    index('tasks_processing_started_at_idx').on(t.processingStartedAt),
    index('tasks_completed_at_idx').on(t.completedAt),

    // Hot partial index for the timeout sweeper.
    index('tasks_sweeper_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'PROCESSING'`),

    uniqueIndex('tasks_idempotency_key_idx')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),

    check(
      'tasks_status_check',
      sql`${t.status} IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),

    // Cross-column state consistency enforced at the DB level.
    // Each row in the matrix represents one valid combination of (status, timestamps).
    check(
      'tasks_valid_state_data',
      sql`
        (${t.status} = 'PENDING'
          AND ${t.processingStartedAt} IS NULL
          AND ${t.completedAt} IS NULL)
        OR
        (${t.status} = 'PROCESSING'
          AND ${t.processingStartedAt} IS NOT NULL
          AND ${t.completedAt} IS NULL)
        OR
        (${t.status} IN ('COMPLETED', 'FAILED')
          AND ${t.processingStartedAt} IS NOT NULL
          AND ${t.completedAt} IS NOT NULL)
        OR
        (${t.status} = 'CANCELLED'
          AND ${t.completedAt} IS NOT NULL)
      `,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Inferred types - use these in repositories and services
// ---------------------------------------------------------------------------

export type TaskInsert = typeof tasks.$inferInsert
export type TaskSelect = typeof tasks.$inferSelect

export const insertTaskSchema = createInsertSchema(tasks)
export const selectTaskSchema = createSelectSchema(tasks)
