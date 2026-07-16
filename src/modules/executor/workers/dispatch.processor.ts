import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { Worker } from 'bullmq'
import { RedisService } from '#libs/redis/index.js'
import {
  HttpRetryService,
  DispatchFailedError,
  NonRetryableError,
} from '#libs/http-retry/index.js'
import { TasksRepository } from '../../tasks/tasks.repository.js'

interface DispatchJobData {
  taskId: string
  timeoutSeconds: number
}

/**
 * Consumes the `dispatch` queue.
 * Transitions a PENDING task to PROCESSING, then POSTs the payload to executorUrl.
 *
 * Error strategy:
 * - HTTP errors (DispatchFailedError, NonRetryableError): update task to FAILED,
 *   complete the job without re-throwing.
 * - Infrastructure errors (DB, Redis): revert task to PENDING, re-throw so
 *   BullMQ marks the job as failed and applies backoff.
 *
 * attempts=1 prevents re-dispatch of a job that already moved the task to PROCESSING.
 */
@Injectable()
export class DispatchProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchProcessor.name)
  private worker!: Worker

  constructor(
    private readonly redis: RedisService,
    private readonly tasksRepo: TasksRepository,
    private readonly httpRetry: HttpRetryService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'dispatch',
      (job) => this.process(job.data as DispatchJobData),
      {
        // Duplicate the client to avoid blocking the shared business connection
        connection: (this.redis.client as import('ioredis').Redis).duplicate(),
        concurrency: 10,
      },
    )

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Dispatch job ${job?.id ?? 'unknown'} failed: ${String(err)}`)
    })

    this.logger.log('Dispatch worker started')
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close()
    this.logger.log('Dispatch worker closed')
  }

  private async process({ taskId, timeoutSeconds }: DispatchJobData): Promise<void> {
    const now = new Date()

    // Atomic PENDING → PROCESSING. If 0 rows updated, another worker or cancellation got here first.
    const task = await this.tasksRepo.updateStatus(taskId, 'PENDING', 'PROCESSING', {
      processingStartedAt: now,
      expiresAt: new Date(now.getTime() + timeoutSeconds * 1_000),
    })

    if (!task) {
      this.logger.warn(
        `Dispatch skipped for taskId=${taskId}: already processed or cancelled`,
      )
      return
    }

    try {
      await this.httpRetry.post(
        task.executorUrl,
        { taskId, payload: task.payload },
        { Authorization: `Bearer ${task.callbackToken ?? ''}` },
        { attempts: 3 },
      )
      this.logger.log(`Dispatched taskId=${taskId} to ${task.executorUrl}`)
    } catch (err) {
      if (err instanceof DispatchFailedError || err instanceof NonRetryableError) {
        const code =
          err instanceof NonRetryableError ? 'EXECUTOR_REJECTED' : 'DISPATCH_FAILED'
        await this.tasksRepo.updateStatus(taskId, 'PROCESSING', 'FAILED', {
          completedAt: new Date(),
          error: { code, message: err.message },
        })
        this.logger.error(
          `Dispatch failed permanently for taskId=${taskId}: ${err.message}`,
        )
        return
      }
      // Infra error (DB/Redis/network) after PROCESSING transition: revert to PENDING
      // so BullMQ can retry without leaving the task stuck.
      await this.tasksRepo
        .updateStatus(taskId, 'PROCESSING', 'PENDING', {
          processingStartedAt: null as unknown as Date,
          expiresAt: null as unknown as Date,
        })
        .catch((revertErr: unknown) => {
          this.logger.error(
            `Failed to revert task ${taskId} to PENDING: ${String(revertErr)}`,
          )
        })
      throw err
    }
  }
}
