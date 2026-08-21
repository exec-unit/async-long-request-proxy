import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { Worker } from 'bullmq'
import { QUEUE_CONFIG, createBullMqConnection } from '#libs/queue/index.js'
import type { QueueConfig } from '#libs/queue/index.js'
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
 * attempts=1 in the queue prevents re-dispatch of a job that already moved the
 * task to PROCESSING. Known limitation: if the HTTP POST succeeds but the
 * subsequent DB update fails, the task reverts to PENDING and may be dispatched
 * again - the executor must be idempotent on its end.
 */
@Injectable()
export class DispatchProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchProcessor.name)
  private worker!: Worker

  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
    private readonly tasksRepo: TasksRepository,
    private readonly httpRetry: HttpRetryService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'dispatch',
      async (job) => this.process(job.data as DispatchJobData),
      { connection: createBullMqConnection(this.config), concurrency: 10 },
    )

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Job ${job?.id ?? 'unknown'} on queue "dispatch" failed: ${String(err)}`,
      )
    })
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close()
  }

  private async process({ taskId, timeoutSeconds }: DispatchJobData): Promise<void> {
    const now = new Date()

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
          processingStartedAt: null,
          expiresAt: null,
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
