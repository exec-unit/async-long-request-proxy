import { Injectable } from '@nestjs/common'
import { and, eq, gt, sql } from 'drizzle-orm'
import { InjectDb } from '#src/database/drizzle/drizzle.provider.js'
import type { DrizzleDb } from '#src/database/drizzle/drizzle.provider.js'
import { taskEvents } from './schemas/events.sql.js'
import type { TaskEventSelect } from './schemas/events.sql.js'
import type { InsertEventInput } from './dto/events.types.js'

// Drizzle transaction type - extracted to keep method signatures readable.
type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0]

/**
 * Data-access layer for the `task_events` table.
 * Events are append-only - no update or delete methods exist by design.
 */
@Injectable()
export class EventsRepository {
  constructor(@InjectDb() private readonly db: DrizzleDb) {}

  /**
   * Inserts an event with a monotonically increasing per-task `seq`.
   * Opens its own transaction; use `insertEventInTx` when a transaction already exists.
   */
  async insertEvent(input: InsertEventInput): Promise<TaskEventSelect> {
    return this.db.transaction((tx) => this.insertEventInTx(tx, input))
  }

  /**
   * Inserts an event inside an **existing** transaction provided by the caller.
   *
   * Designed for composite transactions (e.g. cancelTask, timeout sweep batch)
   * where the event must be atomically coupled with a preceding status UPDATE.
   * Acquires a per-task advisory lock to ensure monotonic seq ordering even
   * when concurrent writers race on the same taskId.
   */
  async insertEventInTx(
    tx: DrizzleTx,
    input: InsertEventInput,
  ): Promise<TaskEventSelect> {
    const { taskId, eventType, ...payloadFields } = input

    // Advisory lock serializes concurrent seq assignment for the same task.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('task_events'), hashtext(${taskId}))`,
    )

    const [seqRow] = await tx
      .select({ nextSeq: sql<number>`COALESCE(MAX(${taskEvents.seq}), 0) + 1` })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))

    const nextSeq = seqRow?.nextSeq ?? 1

    const [inserted] = await tx
      .insert(taskEvents)
      .values({
        taskId,
        seq: nextSeq,
        eventType,
        payload: payloadFields as Record<string, unknown>,
      })
      .returning()

    if (!inserted)
      throw new Error('event INSERT returned no rows - check postgres connection')
    return inserted as TaskEventSelect
  }

  /** Returns events after a given seq number for SSE replay on reconnect. */
  async findEventsSince(taskId: string, afterSeq: number): Promise<TaskEventSelect[]> {
    const rows = await this.db
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), gt(taskEvents.seq, afterSeq)))
      .orderBy(taskEvents.seq)

    return rows as unknown as TaskEventSelect[]
  }
}
