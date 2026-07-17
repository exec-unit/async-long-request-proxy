import { Module } from '@nestjs/common'
import { TasksRepository } from '../tasks/tasks.repository.js'
import { EventsRepository } from '../delivery/events.repository.js'
import { DispatchProcessor } from './workers/dispatch.processor.js'
import { CancelProcessor } from './workers/cancel.processor.js'

/**
 * Worker-specific module for the Executor domain.
 * Contains only background processors.
 * Intentionally excludes HTTP controllers and Guards to prevent
 * exposing API routes on the background worker process.
 */
@Module({
  providers: [TasksRepository, EventsRepository, DispatchProcessor, CancelProcessor],
})
export class ExecutorWorkerModule {}
