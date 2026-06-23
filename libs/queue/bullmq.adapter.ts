import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { Queue } from 'bullmq'
import { Redis, Cluster } from 'ioredis'
import type { IQueueAdapter } from './queue-adapter.interface.js'
import type { JobOptions, QueueJob, QueueConfig } from './queue.types.js'
import { parseClusterNodes } from '#libs/redis/cluster-nodes.util.js'

/** DI token for the queue configuration object. */
export const QUEUE_CONFIG = Symbol('QUEUE_CONFIG')

/**
 * BullMQ-backed IQueueAdapter.
 * Maintains a pool of Queue instances (one per logical queue name).
 * Callers interact only through IQueueAdapter - the BullMQ dependency
 * is contained entirely here and can be swapped without touching feature code.
 */
@Injectable()
export class BullMqAdapter implements IQueueAdapter, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullMqAdapter.name)
  private readonly queues = new Map<string, Queue>()

  constructor(@Inject(QUEUE_CONFIG) private readonly config: QueueConfig) {}

  /**
   * BullMQ Queue instances manage their own connection pool - each gets a fresh
   * client so queue-level errors don't cascade across queues.
   */
  private createClient(): Redis | Cluster {
    if (this.config.clusterMode) {
      if (!this.config.clusterNodes) {
        throw new Error('REDIS_CLUSTER_NODES must be provided when clusterMode is true')
      }
      return new Cluster(parseClusterNodes(this.config.clusterNodes), {
        redisOptions: {
          password: this.config.password,
          db: this.config.db ?? 0,
        },
      })
    }

    return new Redis({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      db: this.config.db ?? 0,
    })
  }

  /**
   * Probes Redis at startup to surface connectivity problems before the app
   * accepts traffic. Throws on failure so NestJS bootstrap is aborted visibly.
   */
  async onModuleInit(): Promise<void> {
    if (this.config.clusterMode) {
      const cluster = this.createClient() as Cluster
      // Suppress the 'error' event - rejection is handled via the awaited ping() below.
      cluster.on('error', () => {})
      try {
        await cluster.ping()
        this.logger.log('Redis cluster connection verified')
      } catch (err) {
        throw new Error(`[BullMqAdapter] Cannot connect to Redis cluster: ${String(err)}`)
      } finally {
        await cluster.quit()
      }
    } else {
      // lazyConnect gives us control over when the TCP handshake happens so we
      // can await it and surface failures synchronously during bootstrap.
      const probe = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.db ?? 0,
        maxRetriesPerRequest: 0,
        connectTimeout: 5000,
        lazyConnect: true,
      })
      // Suppress the 'error' event - rejection is handled via
      // the awaited connect() below.
      probe.on('error', () => {})
      try {
        await probe.connect()
        await probe.ping()
        this.logger.log('Redis connection verified')
      } catch (err) {
        throw new Error(`[BullMqAdapter] Cannot connect to Redis: ${String(err)}`)
      } finally {
        await probe.quit()
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()))
    this.logger.log('All BullMQ queue connections closed')
  }

  /** Returns a cached Queue instance, creating one on first access. */
  private getQueue(name: string): Queue {
    let queue = this.queues.get(name)
    if (!queue) {
      queue = new Queue(name, {
        connection: this.createClient(),
        defaultJobOptions: {
          // Retain completed jobs for 1 h for observability;
          // keep last 100 failed for alerting.
          removeOnComplete: { age: 3600 },
          removeOnFail: { count: 100 },
        },
      })

      queue.on('error', (err) => {
        this.logger.error(`BullMQ queue "${name}" error: ${String(err)}`)
      })

      this.queues.set(name, queue)
    }
    return queue
  }

  async enqueue<T>(
    queueName: string,
    job: QueueJob<T>,
    options?: JobOptions,
  ): Promise<void> {
    try {
      const queue = this.getQueue(queueName)
      await queue.add(job.name, job.data, {
        ...(options?.priority !== undefined && { priority: options.priority }),
        ...(options?.delay !== undefined && { delay: options.delay }),
        attempts: options?.attempts ?? 3,
        ...(options?.backoff !== undefined && {
          backoff: { type: 'fixed' as const, delay: options.backoff },
        }),
      })
    } catch (err) {
      this.logger.error(
        `Failed to enqueue "${job.name}" on "${queueName}": ${String(err)}`,
      )
      throw err
    }
  }
}
