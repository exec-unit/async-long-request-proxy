import { Module } from '@nestjs/common'
import { EventsRepository } from '../delivery/events.repository.js'
import { MaintenanceRepository } from './maintenance.repository.js'
import { TimeoutSweeperProcessor } from './workers/timeout-sweeper.processor.js'
import { DataRetentionProcessor } from './workers/data-retention.processor.js'

/**
 * Worker-side module for cross-cutting maintenance jobs.
 * Both processors register their own BullMQ repeatable schedules on startup.
 */
@Module({
  providers: [
    MaintenanceRepository,
    EventsRepository,
    TimeoutSweeperProcessor,
    DataRetentionProcessor,
  ],
})
export class MaintenanceModule {}
