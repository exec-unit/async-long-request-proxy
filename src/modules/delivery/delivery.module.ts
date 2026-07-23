import { Module } from '@nestjs/common'
import { TasksRepository } from '../tasks/tasks.repository.js'
import { EventsRepository } from './events.repository.js'
import { SseService } from './sse.service.js'
import { StreamController } from './stream.controller.js'

/**
 * API-side module for the Delivery domain.
 * Registers the SSE stream endpoint and its dependencies.
 * Intentionally excludes WebhookProcessor — that belongs to the Worker process.
 */
@Module({
  controllers: [StreamController],
  providers: [SseService, TasksRepository, EventsRepository],
  exports: [EventsRepository],
})
export class DeliveryModule {}
