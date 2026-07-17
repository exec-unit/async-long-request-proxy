import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { TasksRepository } from './tasks.repository.js'
import { IdempotencyService } from '#libs/idempotency/index.js'
import { QUEUE_ADAPTER } from '#libs/queue/index.js'
import type { IQueueAdapter } from '#libs/queue/index.js'
import { Inject } from '@nestjs/common'
import type { CreateTaskDto, TaskCreatedResponseDto } from './dto/tasks.dto.js'
import type { TaskSelect } from './schemas/tasks.sql.js'

/** Default idempotency slot TTL: 24 hours. */
const IDEMPOTENCY_TTL_SECONDS = 86_400

/** Queue name consumed by the dispatch processor in the Worker process. */
const DISPATCH_QUEUE = 'dispatch'

/**
 * Orchestrates task creation with idempotency guarantees.
 * Flow: 1. Redis lock -> 2. Postgres INSERT -> 3. Enqueue dispatch -> 4. Commit lock.
 * Crashes between 2 and 4 leave slot in PENDING until TTL expires, but task still runs.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name)

  constructor(
    private readonly tasksRepo: TasksRepository,
    private readonly idempotency: IdempotencyService,
    @Inject(QUEUE_ADAPTER) private readonly queue: IQueueAdapter,
  ) {}

  async create(dto: CreateTaskDto, baseUrl: string): Promise<TaskCreatedResponseDto> {
    const { idempotencyKey } = dto

    // --- Idempotency check (fast path) ---
    if (idempotencyKey) {
      const slot = await this.idempotency.occupySlot(
        idempotencyKey,
        IDEMPOTENCY_TTL_SECONDS,
      )

      if (slot.status === 'pending') {
        // Another request is creating the same task; return Conflict to trigger client retry.
        throw new ConflictException(
          'A task with this idempotency key is currently being created. Retry in a moment.',
        )
      }

      if (slot.status === 'duplicate') {
        this.logger.debug(
          `Idempotency hit for key=${idempotencyKey}, returning cached taskId`,
        )
        return this.buildResponse(slot.taskId, baseUrl)
      }
    }

    let task: TaskSelect
    try {
      task = await this.tasksRepo.insert({
        type: dto.type,
        payload: dto.payload,
        executorUrl: dto.executorUrl,
        cancelUrl: dto.cancelUrl,
        webhookUrl: dto.webhookUrl,
        timeoutSeconds: dto.timeoutSeconds,
        idempotencyKey: dto.idempotencyKey,
        // Generated once and stored; the worker embeds it in the Authorization header.
        // The executor must present it back when pushing results - never logged or
        // returned to clients.
        callbackToken: randomUUID(),
      })
    } catch (error) {
      // Release the slot so the next retry can attempt creation cleanly.
      if (idempotencyKey) {
        await this.idempotency.releaseSlot(idempotencyKey)
      }
      throw error
    }

    // attempts=1: prevents BullMQ from re-dispatching a job that has already
    // transitioned the task to PROCESSING (double-execution guard).
    try {
      await this.queue.enqueue(
        DISPATCH_QUEUE,
        {
          name: 'dispatch',
          data: { taskId: task.id, timeoutSeconds: task.timeoutSeconds },
        },
        { attempts: 1 },
      )
    } catch (error) {
      this.logger.error(
        `Failed to enqueue dispatch for task ${task.id}, rolling back`,
        error instanceof Error ? error.stack : String(error),
      )
      await this.tasksRepo.deleteById(task.id)
      if (idempotencyKey) {
        await this.idempotency.releaseSlot(idempotencyKey)
      }
      throw error
    }

    if (idempotencyKey) {
      await this.idempotency.commitResult(idempotencyKey, task.id)
    }

    this.logger.log(`Task created: id=${task.id} type=${task.type}`)
    return this.buildResponse(task.id, baseUrl)
  }

  async getStatus(id: string): Promise<TaskSelect> {
    const task = await this.tasksRepo.findById(id)
    if (!task) throw new NotFoundException(`Task ${id} not found`)
    return task
  }

  /** Cancels a PENDING task directly. Worker notifies executors for PROCESSING tasks via cancelUrl. */
  async cancel(id: string): Promise<void> {
    const updatedTask = await this.tasksRepo.updateStatus(
      id,
      ['PENDING', 'PROCESSING'],
      'CANCELLED',
      { completedAt: new Date() },
    )

    if (!updatedTask) {
      // Task was not PENDING/PROCESSING or doesn't exist. Fetch it to give an accurate error.
      const currentTask = await this.tasksRepo.findById(id)
      if (!currentTask) throw new NotFoundException(`Task ${id} not found`)

      throw new ConflictException(
        `Task ${id} cannot be cancelled in its current state (${currentTask.status}).`,
      )
    }

    // cancelUrl notification is best-effort: executor receives it async
    // via cancel.processor.
    if (updatedTask.cancelUrl) {
      await this.queue.enqueue('cancel', { name: 'cancel', data: { taskId: id } })
    }

    this.logger.log(`Task cancelled: id=${id}`)
  }

  private buildResponse(taskId: string, baseUrl: string): TaskCreatedResponseDto {
    return {
      taskId,
      statusUrl: `${baseUrl}/tasks/${taskId}`,
      streamUrl: `${baseUrl}/tasks/${taskId}/stream`,
    }
  }
}
