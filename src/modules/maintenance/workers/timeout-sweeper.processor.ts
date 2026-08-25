import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Inject,
} from '@nestjs/common'
import { Worker, Queue } from 'bullmq'
import { QUEUE_CONFIG, createBullMqConnection } from '#libs/queue/index.js'
import type { QueueConfig } from '#libs/queue/index.js'
import { RedisService } from '#libs/redis/index.js'
import { InjectConfig } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'
import { MaintenanceRepository } from '../maintenance.repository.js'

/** Queue name - also used as the repeatable job key prefix in BullMQ. */
const QUEUE_NAME = 'maintenance-timeout-sweep'
const SWEEP_BATCH_SIZE = 500

/**
 * Repeatable job: scans for PROCESSING tasks past their `expiresAt` deadline
 * and transitions them to FAILED.
 *
 * After each bulk UPDATE the processor inserts a 'failed' event per expired task
 * and publishes to the per-task Pub/Sub channel so live SSE clients terminate cleanly.
 *
 * upsertJobScheduler is idempotent - multiple worker replicas do NOT create
 * duplicate schedules; the queue elects a single runner.
 */
@Injectable()
export class TimeoutSweeperProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeoutSweeperProcessor.name)
  private worker!: Worker
  private queue!: Queue

  constructor(
    @Inject(QUEUE_CONFIG) private readonly queueConfig: QueueConfig,
    private readonly redis: RedisService,
    private readonly maintenanceRepo: MaintenanceRepository,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.queue = new Queue(QUEUE_NAME, {
      connection: createBullMqConnection(this.queueConfig),
    })
    this.worker = new Worker(QUEUE_NAME, () => this.process(), {
      connection: createBullMqConnection(this.queueConfig),
      concurrency: 1,
    })

    // upsertJobScheduler is idempotent across replicas: multiple workers
    // calling this with the same key elect a single scheduled runner.
    void this.queue
      .upsertJobScheduler(
        'timeout-sweep',
        { pattern: this.config.maintenance.timeoutSweeperCron, tz: 'UTC' },
        // attempts=1: retrying the whole sweep after a partial failure could
        // double-fail tasks that were already transitioned in the first attempt.
        { name: 'sweep', opts: { attempts: 1 } },
      )
      .then(() => {
        this.logger.log(
          `Timeout sweeper scheduled: cron="${this.config.maintenance.timeoutSweeperCron}"`,
        )
      })
      .catch((err: unknown) => {
        this.logger.error(`Failed to register timeout sweeper schedule: ${String(err)}`)
      })

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Timeout sweep job ${job?.id ?? 'unknown'} failed: ${String(err)}`,
      )
    })

    this.logger.log('Timeout sweeper worker started')
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close()
    await this.queue.close()
    this.logger.log('Timeout sweeper worker closed')
  }

  private async process(): Promise<void> {
    let totalExpired = 0

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { expiredCount, events } =
        await this.maintenanceRepo.expireTimedOutTasksBatch(SWEEP_BATCH_SIZE)

      if (expiredCount === 0) {
        break
      }

      totalExpired += expiredCount

      // DB insertions are handled in the repository transaction; publish to notify live SSE clients.
      await Promise.allSettled(
        events.map(async (event) => {
          try {
            await this.redis.client.publish(`task:${event.taskId}`, JSON.stringify(event))
          } catch (err) {
            this.logger.error(
              `Failed to publish timeout event for taskId=${event.taskId}: ${String(err)}`,
            )
          }
        }),
      )
    }

    if (totalExpired > 0) {
      this.logger.warn(
        `Timeout sweep: expired a total of ${String(totalExpired)} task(s)`,
      )
    } else {
      this.logger.debug('Timeout sweep: no expired tasks found')
    }
  }
}
