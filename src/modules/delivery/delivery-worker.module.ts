import { Module } from '@nestjs/common'
import { TasksRepository } from '../tasks/tasks.repository.js'
import { WebhookProcessor } from './workers/webhook.processor.js'

/**
 * Worker-side module for the Delivery domain.
 * Contains only the webhook BullMQ processor.
 * Intentionally excludes HTTP controllers and SseService to keep the
 * worker process lean and free of any HTTP-serving infrastructure.
 */
@Module({
  providers: [WebhookProcessor, TasksRepository],
})
export class DeliveryWorkerModule {}
