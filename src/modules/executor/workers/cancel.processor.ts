import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { Worker } from 'bullmq'
import { RedisService } from '#libs/redis/index.js'
import { HttpRetryService, NonRetryableError } from '#libs/http-retry/index.js'
import { TasksRepository } from '../../tasks/tasks.repository.js'

interface CancelJobData {
  taskId: string
}

/**
 * Consumes the `cancel` queue.
 * Notifies the executor about the cancellation by POSTing to the task's cancelUrl.
 * This is best-effort: if the executor's cancel endpoint is unreachable, we log
 * and move on - the task is already in CANCELLED state in the DB.
 * The executor will receive a 409 if it tries to push a result for a cancelled task.
 */
@Injectable()
export class CancelProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CancelProcessor.name)
  private worker!: Worker

  constructor(
    private readonly redis: RedisService,
    private readonly tasksRepo: TasksRepository,
    private readonly httpRetry: HttpRetryService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker('cancel', (job) => this.process(job.data as CancelJobData), {
      connection: (this.redis.client as import('ioredis').Redis).duplicate(),
    })

    this.logger.log('Cancel worker started')
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close()
    this.logger.log('Cancel worker closed')
  }

  private async process({ taskId }: CancelJobData): Promise<void> {
    const task = await this.tasksRepo.findById(taskId)

    if (!task?.cancelUrl) {
      // No cancelUrl configured - nothing to notify
      return
    }

    try {
      await this.httpRetry.post(
        task.cancelUrl,
        { taskId },
        { Authorization: `Bearer ${task.callbackToken ?? ''}` },
        // Fewer retries than dispatch: cancellation is best-effort
        // and not on the critical path.
        { attempts: 2, baseDelayMs: 1_000 },
      )
      this.logger.log(
        `Cancel notification sent for taskId=${taskId} to ${task.cancelUrl}`,
      )
    } catch (err) {
      if (err instanceof NonRetryableError) {
        this.logger.warn(
          `Cancel notification rejected by executor for taskId=${taskId} (status=${String(err.statusCode)}) - ignoring`,
        )
        return
      }
      // For all other failures (including DispatchFailedError): log and swallow.
      // Task state is already CANCELLED - there is nothing more to do.
      this.logger.warn(
        `Cancel notification failed for taskId=${taskId}: ${err instanceof Error ? err.message : String(err)} - ignoring`,
      )
    }
  }
}
