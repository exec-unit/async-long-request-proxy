import { Injectable, Inject, Logger } from '@nestjs/common'
import { QUEUE_ADAPTER } from '#libs/queue/index.js'
import type { IQueueAdapter } from '#libs/queue/index.js'
import { RedisService } from '#libs/redis/index.js'
import { TasksRepository } from '../tasks/tasks.repository.js'
import type { TaskSelect } from '../tasks/schemas/tasks.sql.js'
import { EventsRepository } from '../delivery/events.repository.js'
import type { SubmitResultDto, UpdateProgressDto } from './dto/executor.dto.js'

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name)

  constructor(
    private readonly tasksRepo: TasksRepository,
    private readonly eventsRepo: EventsRepository,
    private readonly redis: RedisService,
    @Inject(QUEUE_ADAPTER) private readonly queue: IQueueAdapter,
  ) {}

  /**
   * Handles the executor's final result push.
   * Transitions PROCESSING → COMPLETED or FAILED, persists the event,
   * publishes to Pub/Sub (for SSE), and optionally enqueues a webhook delivery.
   *
   * Returns early (no-op) if the task is no longer in PROCESSING state -
   * e.g. it was expired by the timeout sweeper while the executor was still running.
   */
  async submitResult(task: TaskSelect, dto: SubmitResultDto): Promise<void> {
    if (dto.status === 'completed') {
      const updated = await this.tasksRepo.updateStatus(
        task.id,
        'PROCESSING',
        'COMPLETED',
        {
          result: dto.result,
          completedAt: new Date(),
        },
      )
      if (!updated) {
        this.logger.warn(
          `Task ${task.id} result ignored: task is no longer in PROCESSING state`,
        )
        return
      }
      const event = await this.eventsRepo.insertEvent({
        taskId: task.id,
        eventType: 'completed',
        data: dto.result,
      })
      await this.publish(task.id, event)
    } else {
      const updated = await this.tasksRepo.updateStatus(task.id, 'PROCESSING', 'FAILED', {
        error: dto.error,
        completedAt: new Date(),
      })
      if (!updated) {
        this.logger.warn(
          `Task ${task.id} failure ignored: task is no longer in PROCESSING state`,
        )
        return
      }
      const event = await this.eventsRepo.insertEvent({
        taskId: task.id,
        eventType: 'failed',
        error: dto.error,
      })
      await this.publish(task.id, event)
    }

    this.logger.log(`Task ${task.id} result submitted: status=${dto.status}`)

    if (task.webhookUrl) {
      await this.queue.enqueue('webhook', {
        name: 'webhook',
        data: { taskId: task.id },
      })
    }
  }

  /** Updates the numeric progress field and publishes a progress event for SSE consumers. */
  async updateProgress(task: TaskSelect, dto: UpdateProgressDto): Promise<void> {
    await this.tasksRepo.updateProgress(task.id, dto.progress)

    const event = await this.eventsRepo.insertEvent({
      taskId: task.id,
      eventType: 'progress',
      progress: dto.progress,
    })
    await this.publish(task.id, event)

    this.logger.debug(`Task ${task.id} progress updated: ${String(dto.progress)}%`)
  }

  /** Publishes an event payload to the per-task Redis Pub/Sub channel. */
  private async publish(taskId: string, event: unknown): Promise<void> {
    await this.redis.client.publish(`task:${taskId}`, JSON.stringify(event))
  }
}
