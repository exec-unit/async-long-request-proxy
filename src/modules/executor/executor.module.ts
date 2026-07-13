import { Module } from '@nestjs/common'
import { TasksRepository } from '../tasks/tasks.repository.js'
import { EventsRepository } from '../delivery/events.repository.js'
import { CallbackAuthGuard } from './guards/callback-auth.guard.js'
import { ExecutorService } from './executor.service.js'
import { ExecutorController } from './executor.controller.js'

/**
 * API-specific module for the Executor domain.
 * Contains only HTTP controllers and their dependencies.
 */
@Module({
  controllers: [ExecutorController],
  providers: [TasksRepository, EventsRepository, CallbackAuthGuard, ExecutorService],
})
export class ExecutorModule {}
