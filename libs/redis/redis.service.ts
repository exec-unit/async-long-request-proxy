import { Injectable, Logger } from '@nestjs/common'
import type { OnModuleDestroy } from '@nestjs/common'
import { Redis, Cluster } from 'ioredis'
import type { RedisModuleOptions } from './redis.module.js'
import { parseClusterNodes } from './cluster-nodes.util.js'

/** Stored constructor options for creating isolated clients on demand. */
let _storedOptions: RedisModuleOptions | null = null

/**
 * Thin wrapper around ioredis providing the subset of operations
 * used across the proxy (get/set/del/expire/scan).
 * Expose the raw client via `client` only if a caller genuinely needs
 * commands outside this surface - prefer adding a typed method here instead.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  private readonly isCluster: boolean
  readonly client: Redis | Cluster

  constructor(options: RedisModuleOptions) {
    this.isCluster = options.clusterMode === true
    _storedOptions = options

    if (this.isCluster) {
      if (!options.clusterNodes) {
        throw new Error(
          'REDIS_CLUSTER_NODES must be provided when REDIS_CLUSTER_MODE is true',
        )
      }

      this.client = new Cluster(parseClusterNodes(options.clusterNodes), {
        redisOptions: {
          password: options.password,
          db: options.db,
          maxRetriesPerRequest: null,
        },
      })
    } else {
      this.client = new Redis({
        host: options.host,
        port: options.port,
        password: options.password,
        db: options.db,
        maxRetriesPerRequest: null,
      })
    }

    this.client.on('error', (err: Error) => {
      this.logger.error('Redis connection error', err.stack)
    })
  }

  /**
   * Creates a fresh, isolated Redis client with the same connection parameters.
   * Required by BullMQ workers and SSE subscribers - ioredis enters subscriber-only
   * mode on `.subscribe()`, and BullMQ workers must not share the business connection.
   *
   * Handles both standalone (Redis.duplicate) and Cluster (new Cluster) modes correctly.
   * Casting to Redis and calling `.duplicate()` silently breaks in cluster mode.
   */
  createIsolatedClient(): Redis | Cluster {
    const opts = _storedOptions
    if (!opts) throw new Error('RedisService not yet initialized')

    if (this.isCluster) {
      if (!opts.clusterNodes) {
        throw new Error('REDIS_CLUSTER_NODES must be provided when clusterMode is true')
      }
      return new Cluster(parseClusterNodes(opts.clusterNodes), {
        redisOptions: {
          password: opts.password,
          db: opts.db,
          maxRetriesPerRequest: null,
        },
      })
    }

    return (this.client as Redis).duplicate()
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<'OK'> {
    if (ttlSeconds !== undefined) {
      return this.client.set(key, value, 'EX', ttlSeconds)
    }
    return this.client.set(key, value)
  }

  async del(key: string): Promise<number> {
    return this.client.del(key)
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    return this.client.expire(key, ttlSeconds)
  }

  /**
   * Scans keys by pattern.
   * In cluster mode, fans out SCAN to every master node - a single-node SCAN
   * would miss keys hashed to other shards.
   */
  async scanKeys(pattern: string): Promise<string[]> {
    if (this.isCluster) {
      return this.scanClusterKeys(pattern)
    }
    return this.scanSingleKeys(pattern)
  }

  private async scanSingleKeys(pattern: string): Promise<string[]> {
    let cursor = '0'
    const keys: string[] = []
    do {
      const result = await (this.client as Redis).scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      )
      cursor = result[0]
      keys.push(...result[1])
    } while (cursor !== '0')
    return keys
  }

  private async scanClusterKeys(pattern: string): Promise<string[]> {
    const cluster = this.client as Cluster
    const masters = cluster.nodes('master')
    const results = await Promise.all(
      masters.map(async (node) => {
        let cursor = '0'
        const nodeKeys: string[] = []
        do {
          const result = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
          cursor = result[0]
          nodeKeys.push(...result[1])
        } while (cursor !== '0')
        return nodeKeys
      }),
    )
    return results.flat()
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit()
  }
}
