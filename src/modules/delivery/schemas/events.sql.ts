import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  bigint,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Event type discriminated union
// ---------------------------------------------------------------------------

/** All SSE event types emitted during a task's lifecycle. */
export const TASK_EVENT_TYPES = ['progress', 'completed', 'failed', 'cancelled'] as const
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number]

/**
 * Typed payload for each event variant.
 * Consumers must narrow via `eventType` before reading variant-specific fields.
 */
export type TaskEventPayload =
  | { eventType: 'progress'; progress: number }
  | { eventType: 'completed'; data: Record<string, unknown> }
  | { eventType: 'failed'; error: { code: string; message: string; details?: unknown } }
  | { eventType: 'cancelled' }

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

/**
 * Append-only event log for each task.
 *
 * Design decisions:
 * - `seq` is a monotonic per-task counter used as the SSE Last-Event-ID.
 *   Clients reconnecting with Last-Event-ID replay missed events cheaply.
 * - Table is intentionally append-only — no updates, no deletes during task lifetime.
 * - Future: partition by created_at to enable cheap DROP PARTITION for old data.
 */
export const taskEvents = pgTable(
  'task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),

    // Monotonic sequence used as SSE Last-Event-ID for resume capabilities
    seq: bigint('seq', { mode: 'number' }).notNull(),

    eventType: text('event_type').notNull().$type<TaskEventType>(),

    payload: jsonb('payload')
      .notNull()
      .default({})
      .$type<Omit<TaskEventPayload, 'eventType'>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('task_events_task_id_seq_unique_idx').on(t.taskId, t.seq),
    index('task_events_created_at_idx').on(t.createdAt),

    check(
      'task_events_type_check',
      sql`${t.eventType} IN ('progress', 'completed', 'failed', 'cancelled')`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

type TaskEventInsertBase = typeof taskEvents.$inferInsert

/**
 * Use this type when inserting events.
 * Enforces the discriminated union: TypeScript will reject a payload
 * that does not match the declared eventType.
 */
export type TaskEventInsert = Omit<TaskEventInsertBase, 'eventType' | 'payload'> &
  TaskEventPayload

type TaskEventSelectBase = typeof taskEvents.$inferSelect

/** Hydrated event row with the discriminated payload union applied. */
export type TaskEventSelect = Omit<TaskEventSelectBase, 'eventType' | 'payload'> &
  TaskEventPayload
