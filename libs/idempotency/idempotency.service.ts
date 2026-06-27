import { Injectable, Logger } from '@nestjs/common'
import { RedisService } from '#libs/redis/index.js'

/** Outcome of attempting to occupy an idempotency slot. */
export type OccupySlotResult =
  { status: 'acquired' } | { status: 'pending' } | { status: 'duplicate'; taskId: string }

const KEY_PREFIX = 'idempotency'
// Sentinel value written atomically when a slot is first acquired but the
// task INSERT has not yet committed. Distinguishes "in-flight creation" from
// "completed creation with a known taskId".
const PENDING_SENTINEL = '__PENDING__'

/**
 * Two-phase Redis lock: 1. SET NX __PENDING__ (occupy), 2. SET {taskId} KEEPTTL (commit).
 * Prevents race conditions during DB INSERT and handles crashes via TTL expiration.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name)

  constructor(private readonly redis: RedisService) {}

  /** Acquires idempotency slot. Returns 'acquired' (free), 'pending' (in-flight), or 'duplicate' (cached taskId). */
  async occupySlot(key: string, ttlSeconds: number): Promise<OccupySlotResult> {
    const redisKey = `${KEY_PREFIX}:${key}`

    const acquired = await this.redis.client.set(
      redisKey,
      PENDING_SENTINEL,
      'EX',
      ttlSeconds,
      'NX',
    )

    if (acquired === 'OK') {
      return { status: 'acquired' }
    }

    // Slot is taken - inspect the value to differentiate the two cases.
    const existing = await this.redis.get(redisKey)

    if (existing === null || existing === PENDING_SENTINEL) {
      // Another process is currently creating the task.
      return { status: 'pending' }
    }

    // A completed taskId was committed previously.
    return { status: 'duplicate', taskId: existing }
  }

  /** Commits the taskId into the occupied slot (uses KEEPTTL to preserve expiry). */
  async commitResult(key: string, taskId: string): Promise<void> {
    const redisKey = `${KEY_PREFIX}:${key}`
    // KEEPTTL is supported since Redis 6.0 - our redis.service exposes raw client.
    await this.redis.client.set(redisKey, taskId, 'KEEPTTL')
    this.logger.debug(`Idempotency slot committed: key=${key} taskId=${taskId}`)
  }

  /** Releases slot on failed creation to prevent permanent leakage. */
  async releaseSlot(key: string): Promise<void> {
    const redisKey = `${KEY_PREFIX}:${key}`
    await this.redis.del(redisKey)
    this.logger.warn(`Idempotency slot released after failed creation: key=${key}`)
  }
}
