import { Injectable, Logger } from '@nestjs/common'
import { eq, lt, and, inArray, sql } from 'drizzle-orm'
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
      // The subquery grabs a chunk of IDs exclusively without waiting for locks.
      // Includes both PENDING and PROCESSING to sweep orphaned tasks.
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
        .returning({ id: tasks.id, error: tasks.error })

      if (expired.length === 0) {
        return { expiredCount: 0, events: [] }
      }

      const eventsToInsert = []
      for (const task of expired) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('task_events'), hashtext(${task.id}))`,
        )
        const [seqRow] = await tx
          .select({ nextSeq: sql<number>`COALESCE(MAX(${taskEvents.seq}), 0) + 1` })
          .from(taskEvents)
          .where(eq(taskEvents.taskId, task.id))

        eventsToInsert.push({
          taskId: task.id,
          seq: seqRow?.nextSeq ?? 1,
          eventType: 'failed' as const,
          payload: { error: timeoutError },
        })
      }

      const insertedEvents = await tx
        .insert(taskEvents)
        .values(eventsToInsert)
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
