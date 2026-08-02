import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { Worker, Queue } from 'bullmq'
import { RedisService } from '#libs/redis/index.js'
import { InjectConfig } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'
import { MaintenanceRepository } from '../maintenance.repository.js'

/** Queue name for the data-retention repeatable job. */
const QUEUE_NAME = 'maintenance-data-retention'

/**
 * Repeatable job: deletes terminal tasks and their events older than
 * `DATA_RETENTION_DAYS`. Runs on a cron schedule (default: 03:00 UTC daily)
 * to avoid peak traffic hours. Batching is handled by MaintenanceRepository.
 */
@Injectable()
export class DataRetentionProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataRetentionProcessor.name)
  private worker!: Worker
  private queue!: Queue

  constructor(
    private readonly redis: RedisService,
    private readonly maintenanceRepo: MaintenanceRepository,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const baseClient = this.redis.client as import('ioredis').Redis
    this.queue = new Queue(QUEUE_NAME, { connection: baseClient.duplicate() })
    this.worker = new Worker(QUEUE_NAME, () => this.process(), {
      connection: baseClient.duplicate(),
      concurrency: 1,
    })

    void this.queue
      .upsertJobScheduler(
        'data-retention',
        { pattern: this.config.maintenance.dataRetentionCron, tz: 'UTC' },
        // attempts=1: deletion is idempotent, but a DB failure should be fixed at
        // the root rather than silently retried.
        { name: 'retain', opts: { attempts: 1 } },
      )
      .then(() => {
        this.logger.log(
          `Data retention scheduled: cron="${this.config.maintenance.dataRetentionCron}" retentionDays=${String(this.config.maintenance.dataRetentionDays)}`,
        )
      })
      .catch((err: unknown) => {
        this.logger.error(`Failed to register data-retention schedule: ${String(err)}`)
      })

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Data retention job ${job?.id ?? 'unknown'} failed: ${String(err)}`,
      )
    })

    this.logger.log('Data retention worker started')
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close()
    await this.queue.close()
    this.logger.log('Data retention worker closed')
  }

  private async process(): Promise<void> {
    const { dataRetentionDays } = this.config.maintenance

    this.logger.log(
      `Data retention: scanning for tasks older than ${String(dataRetentionDays)} days`,
    )

    const { deletedEventsCount, deletedTasksCount } =
      await this.maintenanceRepo.deleteOldData(dataRetentionDays)

    if (deletedTasksCount === 0) {
      this.logger.log('Data retention: nothing to delete')
      return
    }

    this.logger.log(
      `Data retention: deleted ${String(deletedTasksCount)} task(s) and ${String(deletedEventsCount)} event(s)`,
    )
  }
}
