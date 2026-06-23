/**
 * Generic payload for a job pushed into the queue.
 * `name` - unique discriminator used by workers to filter relevant jobs.
 */
export interface QueueJob<T = unknown> {
  name: string
  data: T
}

/** Options passed to the underlying queue transport when enqueuing a job. */
export interface JobOptions {
  /** Job priority: lower value = higher priority (BullMQ convention). */
  priority?: number
  /** Delay in ms before the job becomes active. */
  delay?: number
  /** Number of retry attempts on failure. */
  attempts?: number
  /** Milliseconds between retry attempts. */
  backoff?: number
}

/** Configuration required to bootstrap the queue adapter. */
export interface QueueConfig {
  host: string
  port: number
  password?: string | undefined
  db?: number | undefined
  clusterMode?: boolean
  clusterNodes?: string | undefined
}
