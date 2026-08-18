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

interface WebhookJobData {
  taskId: string
}

/**
 * Consumes the `webhook` queue.
 * Delivers the final task result to the client-configured webhookUrl (best-effort).
 *
 * The task is already in a terminal state by the time this runs - delivery
 * failure does NOT change task status. Uses exponential backoff for transient
 * failures; 4xx responses are treated as non-retryable client misconfiguration.
 */
@Injectable()
export class WebhookProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookProcessor.name)
  private worker!: Worker

  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
    private readonly tasksRepo: TasksRepository,
    private readonly httpRetry: HttpRetryService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'webhook',
      async (job) => this.process(job.data as WebhookJobData),
      { connection: createBullMqConnection(this.config), concurrency: 20 },
    )

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Job ${job?.id ?? 'unknown'} on queue "webhook" failed: ${String(err)}`,
      )
    })
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close()
  }

  private async process({ taskId }: WebhookJobData): Promise<void> {
    // Always re-fetch from DB: job data is enqueued at result-submission time
    // but the DB state is the authoritative source of truth.
    const task = await this.tasksRepo.findById(taskId)

    if (!task) {
      this.logger.warn(`Webhook skipped: task ${taskId} no longer exists`)
      return
    }

    if (!task.webhookUrl) {
      this.logger.warn(`Webhook skipped: task ${taskId} has no webhookUrl`)
      return
    }

    const payload: Record<string, unknown> = {
      taskId: task.id,
      status: task.status,
      // Use loose inequality to catch both null and undefined from Drizzle nullable columns
      ...(task.result != null ? { result: task.result } : {}),
      ...(task.error != null ? { error: task.error } : {}),
    }

    try {
      await this.httpRetry.post(
        task.webhookUrl,
        payload,
        {},
        { attempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 },
      )
      this.logger.log(`Webhook delivered for taskId=${taskId} to ${task.webhookUrl}`)
    } catch (err) {
      if (err instanceof NonRetryableError) {
        this.logger.error(
          `Webhook delivery rejected (non-retryable) for taskId=${taskId}: ${err.message}`,
        )
        return
      }

      if (err instanceof DispatchFailedError) {
        this.logger.error(
          `webhook_delivery_failed taskId=${taskId} url=${task.webhookUrl}: ${err.message}`,
        )
        return
      }

      // Unexpected error (e.g. DB outage on re-fetch) - re-throw to retry the job.
      throw err
    }
  }
}
