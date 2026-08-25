import { Injectable, Logger } from '@nestjs/common'
import { lt, and, inArray, sql } from 'drizzle-orm'
import { InjectDb } from '#src/database/drizzle/drizzle.provider.js'
import type { DrizzleDb } from '#src/database/drizzle/drizzle.provider.js'
import { tasks } from '../tasks/schemas/tasks.sql.js'
import { taskEvents } from '../delivery/schemas/events.sql.js'
import type { TaskEventSelect } from '../delivery/schemas/events.sql.js'

export interface TimeoutSweeperResult {
  expiredCount: number
  events: TaskEventSelect[]
}

export interface DataRetentionResult {
  deletedEventsCount: number
  deletedTasksCount: number
}

/**
 * Batch size for data-retention deletes.
 * Keeping it small prevents long-held locks and WAL bloat on large tables.
 */
const RETENTION_DELETE_BATCH_SIZE = 500

/**
 * Data-access layer for maintenance operations.
 * All methods perform batch mutations and are designed to be idempotent and
 * safe to re-run on restart (BullMQ repeatable jobs execute at-least-once).
 */
@Injectable()
export class MaintenanceRepository {
  private readonly logger = new Logger(MaintenanceRepository.name)

  constructor(@InjectDb() private readonly db: DrizzleDb) {}

  /**
   * Atomically transitions a batch of expired PROCESSING tasks to FAILED.
   * Uses `FOR UPDATE SKIP LOCKED` and `LIMIT` to prevent lock contention
   * and WAL bloat during concurrent sweeps or API cancellations.
   */
  async expireTimedOutTasksBatch(batchSize: number = 500): Promise<TimeoutSweeperResult> {
    const now = new Date()
    const timeoutError = {
      code: 'BUSINESS_TIMEOUT',
      message: 'Task exceeded its configured timeout and was automatically failed.',
    }

    return this.db.transaction(async (tx) => {
      // SKIP LOCKED prevents waiting on rows held by a concurrent sweep or cancellation.
      const expiredIdsQuery = tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(inArray(tasks.status, ['PENDING', 'PROCESSING']), lt(tasks.expiresAt, now)),
        )
        .limit(batchSize)
        .for('update', { skipLocked: true })

      const expired = await tx
        .update(tasks)
        .set({
          status: 'FAILED',
          completedAt: now,
          error: timeoutError,
        })
        .where(inArray(tasks.id, expiredIdsQuery))
        .returning({ id: tasks.id })

      if (expired.length === 0) {
        return { expiredCount: 0, events: [] }
      }

      const expiredIds = expired.map((t) => t.id)

      // Bulk-insert events using a single statement with ROW_NUMBER() OVER (PARTITION BY task_id)
      // to assign monotonically increasing seq per task without per-row advisory locks.
      // Trades strict ordering guarantees (already ensured by the preceding FOR UPDATE) for
      // throughput on large expiration batches.
      const uuidArray = sql`ARRAY[${sql.join(
        expiredIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`

      const insertedEvents = await tx
        .insert(taskEvents)
        .select(
          sql`
            SELECT
              gen_random_uuid() AS id,
              t.task_id,
              COALESCE(
                (SELECT MAX(seq) FROM task_events WHERE task_id = t.task_id),
                0
              ) + ROW_NUMBER() OVER (PARTITION BY t.task_id ORDER BY t.task_id) AS seq,
              'failed' AS event_type,
              ${JSON.stringify({ error: timeoutError })}::jsonb AS payload,
              NOW() AS created_at
            FROM unnest(${uuidArray}) AS t(task_id)
          `,
        )
        .returning()

      return {
        expiredCount: expired.length,
        events: insertedEvents as TaskEventSelect[],
      }
    })
  }

  /**
   * Idempotently deletes terminal tasks and events older than `retentionDays`.
   * Executes in small batches (events first, then tasks) to prevent
   * long-running transactions, lock contention, and orphaned rows.
   * In-flight PENDING/PROCESSING tasks are never pruned.
   */
  async deleteOldData(retentionDays: number): Promise<DataRetentionResult> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)

    let totalDeletedEvents = 0
    let totalDeletedTasks = 0

    let batch: { id: string }[]

    do {
      batch = await this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            inArray(tasks.status, ['COMPLETED', 'FAILED', 'CANCELLED']),
            lt(tasks.createdAt, cutoff),
          ),
        )
        .limit(RETENTION_DELETE_BATCH_SIZE)

      if (batch.length === 0) break

      const ids = batch.map((r) => r.id)

      const [deletedEvents, deletedTasks] = await this.db.transaction(async (tx) => {
        const events = await tx
          .delete(taskEvents)
          .where(inArray(taskEvents.taskId, ids))
          .returning({ id: taskEvents.id })

        const taskRows = await tx
          .delete(tasks)
          .where(inArray(tasks.id, ids))
          .returning({ id: tasks.id })

        return [events, taskRows]
      })

      totalDeletedEvents += deletedEvents.length
      totalDeletedTasks += deletedTasks.length

      this.logger.debug(
        `Data retention batch: deleted ${String(deletedTasks.length)} tasks, ${String(deletedEvents.length)} events`,
      )
    } while (batch.length >= RETENTION_DELETE_BATCH_SIZE)

    return {
      deletedEventsCount: totalDeletedEvents,
      deletedTasksCount: totalDeletedTasks,
    }
  }
}
