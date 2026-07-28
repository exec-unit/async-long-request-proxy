import { Module } from '@nestjs/common'
import { TasksRepository } from '../tasks/tasks.repository.js'
import { CallbackAuthGuard } from './guards/callback-auth.guard.js'
import { ExecutorService } from './executor.service.js'
import { ExecutorController } from './executor.controller.js'
import { DeliveryModule } from '../delivery/delivery.module.js'

/**
 * Imports DeliveryModule to share the EventsRepository singleton
 * already registered there — avoids a duplicate provider instance
 * that would break NestJS DI scope semantics.
 */
@Module({
  imports: [DeliveryModule],
  controllers: [ExecutorController],
  providers: [TasksRepository, CallbackAuthGuard, ExecutorService],
})
export class ExecutorModule {}
