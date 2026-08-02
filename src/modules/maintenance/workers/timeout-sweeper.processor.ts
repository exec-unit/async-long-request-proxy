import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { Worker, Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { RedisService } from '#libs/redis/index.js'
import { InjectConfig } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'
import { MaintenanceRepository } from '../maintenance.repository.js'

/** Queue name - also used as the repeatable job key prefix in BullMQ. */
const QUEUE_NAME = 'maintenance-timeout-sweep'

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
    private readonly redis: RedisService,
    private readonly maintenanceRepo: MaintenanceRepository,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // Queue and Worker each require their own Redis connection; both are duplicated
    // from the same base client to avoid chaining duplicates.
    const baseClient = this.redis.client as Redis
    this.queue = new Queue(QUEUE_NAME, { connection: baseClient.duplicate() })
    this.worker = new Worker(QUEUE_NAME, () => this.process(), {
      connection: baseClient.duplicate(),
      concurrency: 1,
    })

    // upsertJobScheduler is idempotent: updating the cron is a no-op if unchanged.
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
    const BATCH_SIZE = 500

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { expiredCount, events } =
        await this.maintenanceRepo.expireTimedOutTasksBatch(BATCH_SIZE)

      if (expiredCount === 0) {
        break
      }

      totalExpired += expiredCount

      // The DB insertion is already handled atomically in the repository transaction.
      // We only need to publish to Redis for live SSE clients.
      // This is fast and does not exhaust the Postgres connection pool.
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
