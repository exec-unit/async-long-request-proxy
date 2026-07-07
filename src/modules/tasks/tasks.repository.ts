import { Injectable } from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import { tasks } from './schemas/tasks.sql.js'
import type { TaskInsert, TaskSelect, TaskStatus } from './schemas/tasks.sql.js'
import type { DrizzleDb } from '#src/database/drizzle/drizzle.provider.js'
import { InjectDb } from '#src/database/drizzle/drizzle.provider.js'

@Injectable()
export class TasksRepository {
  constructor(@InjectDb() private readonly db: DrizzleDb) {}

  async insert(dto: TaskInsert): Promise<TaskSelect> {
    const rows = await this.db.insert(tasks).values(dto).returning()
    const row = rows[0]
    if (!row) throw new Error('INSERT returned no rows - check postgres connection')
    return row
  }

  async findById(id: string): Promise<TaskSelect | null> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return row ?? null
  }

  /**
   * Hard delete. Used exclusively for rolling back failed creations
   * (e.g., if queue enqueue fails) to prevent orphaned PENDING tasks.
   */
  async deleteById(id: string): Promise<void> {
    await this.db.delete(tasks).where(eq(tasks.id, id))
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    await this.db.update(tasks).set({ progress }).where(eq(tasks.id, id))
  }

  /**
   * Atomic conditional UPDATE guarded by the current status.
   * Ensures only one worker successfully transitions a task.
   */
  async updateStatus(
    id: string,
    from: TaskStatus | TaskStatus[],
    to: TaskStatus,
    extra?: Partial<TaskInsert>,
  ): Promise<TaskSelect | null> {
    const condition = Array.isArray(from)
      ? inArray(tasks.status, from)
      : eq(tasks.status, from)

    const result = await this.db
      .update(tasks)
      .set({ status: to, ...extra })
      .where(and(eq(tasks.id, id), condition))
      .returning()

    return result.length > 0 ? (result[0] ?? null) : null
  }
}
