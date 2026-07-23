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

interface WebhookJobData {
  taskId: string
}

/**
 * Consumes the `webhook` queue.
 * Delivers the final task result to the client-configured webhookUrl (best-effort).
 *
 * The task is already in a terminal state by the time this runs — delivery
 * failure does NOT change task status. Uses exponential backoff for transient
 * failures; 4xx responses are treated as non-retryable client misconfiguration.
 */
@Injectable()
export class WebhookProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookProcessor.name)
  private worker!: Worker

  constructor(
    private readonly redis: RedisService,
    private readonly tasksRepo: TasksRepository,
    private readonly httpRetry: HttpRetryService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'webhook',
      (job) => this.process(job.data as WebhookJobData),
      {
        // Workers must not share the business Redis connection.
        connection: (this.redis.client as import('ioredis').Redis).duplicate(),
        concurrency: 20,
      },
    )

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Webhook job ${job?.id ?? 'unknown'} failed permanently: ${String(err)}`,
      )
    })

    this.logger.log('Webhook worker started')
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close()
    this.logger.log('Webhook worker closed')
  }

  private async process({ taskId }: WebhookJobData): Promise<void> {
    // Always re-fetch from DB: job data is enqueued at result-submission time
    // but the DB state is the authoritative source of truth.
    const task = await this.tasksRepo.findById(taskId)

    if (!task) {
      // Task was deleted between enqueue and now (e.g. retention sweep).
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
      ...(task.result !== null ? { result: task.result } : {}),
      ...(task.error !== null ? { error: task.error } : {}),
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
        // 4xx from the webhookUrl endpoint — client-side misconfiguration, pointless to retry.
        this.logger.error(
          `Webhook delivery rejected (non-retryable) for taskId=${taskId}: ${err.message}`,
        )
        return
      }

      if (err instanceof DispatchFailedError) {
        // All retry attempts exhausted — webhook_delivery_failed event for downstream alerting.
        this.logger.error(
          `webhook_delivery_failed taskId=${taskId} url=${task.webhookUrl}: ${err.message}`,
        )
        return
      }

      // Unexpected error (e.g. DB outage on re-fetch) — re-throw to retry the job.
      throw err
    }
  }
}
