import { Injectable, Logger } from '@nestjs/common'
import type { OnModuleDestroy } from '@nestjs/common'
import { Redis } from 'ioredis'
import type { RedisModuleOptions } from './redis.module.js'

/**
 * Thin wrapper around ioredis providing the subset of operations
 * used across the proxy (get/set/del/expire/scan).
 * Expose the raw client via `client` only if a caller genuinely needs
 * commands outside this surface — prefer adding a typed method here instead.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  readonly client: Redis

  constructor(options: RedisModuleOptions) {
    this.client = new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      db: options.db,
    })

    this.client.on('error', (err: Error) => {
      this.logger.error('Redis connection error', err.stack)
    })
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
   * Iterates via SCAN to avoid blocking the Redis event loop on large keyspaces.
   * Prefer over KEYS in any environment with > a few thousand keys.
   */
  async scanKeys(pattern: string): Promise<string[]> {
    let cursor = '0'
    const keys: string[] = []
    do {
      const result = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = result[0]
      keys.push(...result[1])
    } while (cursor !== '0')
    return keys
  }

  onModuleDestroy(): void {
    this.client.disconnect()
  }
}
