import type { JobOptions, QueueJob } from './queue.types.js'

/**
 * Abstract contract for a queue transport.
 * Swap BullMQ for Kafka (or any broker) by providing a new implementation
 * without touching any business-level code.
 */
export interface IQueueAdapter {
  /**
   * Pushes a job onto the specified queue.
   * @param queueName - Logical name of the queue / topic.
   * @param job       - Job descriptor with a discriminator name and typed payload.
   * @param options   - Optional delivery hints (priority, delay, retries…).
   */
  enqueue<T>(queueName: string, job: QueueJob<T>, options?: JobOptions): Promise<void>
}

/** DI injection token for IQueueAdapter. */
export const QUEUE_ADAPTER = Symbol('IQueueAdapter')
