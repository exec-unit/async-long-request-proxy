import { Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { InjectDb } from '#src/database/drizzle/drizzle.provider.js'
import type { DrizzleDb } from '#src/database/drizzle/drizzle.provider.js'
import { taskEvents } from './schemas/events.sql.js'
import type { TaskEventSelect } from './schemas/events.sql.js'
import type { InsertEventInput } from './dto/events.types.js'

/**
 * Data-access layer for the `task_events` table.
 * Events are append-only - no update or delete methods exist by design.
 */
@Injectable()
export class EventsRepository {
  constructor(@InjectDb() private readonly db: DrizzleDb) {}

  /**
   * Inserts an event with a monotonically increasing per-task `seq`.
   * Uses `pg_advisory_xact_lock` to serialize concurrent inserts for the same task
   * without requiring SERIALIZABLE isolation on the whole transaction.
   */
  async insertEvent(input: InsertEventInput): Promise<TaskEventSelect> {
    const { taskId, eventType, ...payloadFields } = input

    const row = await this.db.transaction(async (tx) => {
      // Advisory lock prevents race condition during concurrent inserts for the same task
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('task_events'), hashtext(${taskId}))`,
      )

      const [seqRow] = await tx
        .select({ nextSeq: sql<number>`COALESCE(MAX(${taskEvents.seq}), 0) + 1` })
        .from(taskEvents)
        .where(sql`${taskEvents.taskId} = ${taskId}`)

      const nextSeq = seqRow?.nextSeq ?? 1

      const [inserted] = await tx
        .insert(taskEvents)
        .values({
          taskId,
          seq: nextSeq,
          eventType: eventType,
          // payloadFields carries the variant-specific data (progress, data, error, or nothing)
          payload: payloadFields as Record<string, unknown>,
        })
        .returning()

      return inserted
    })

    if (!row) throw new Error('event INSERT returned no rows - check postgres connection')

    return row as TaskEventSelect
  }

  /** Returns events after a given seq number for SSE replay on reconnect. */
  async findEventsSince(taskId: string, afterSeq: number): Promise<TaskEventSelect[]> {
    const rows = await this.db
      .select()
      .from(taskEvents)
      .where(sql`${taskEvents.taskId} = ${taskId} AND ${taskEvents.seq} > ${afterSeq}`)
      .orderBy(taskEvents.seq)

    return rows as unknown as TaskEventSelect[]
  }
}
