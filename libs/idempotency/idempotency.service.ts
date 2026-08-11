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
 * Lua script that atomically tries SET NX and, on failure, immediately returns
 * the existing value - all in a single round-trip with no race window between the
 * two operations.
 *
 * Returns: [1, nil] on acquisition (slot was free)
 *          [0, existing_value] when slot is already taken
 */
const OCCUPY_SCRIPT = `
  local ok = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
  if ok then return {1, false} end
  return {0, redis.call('GET', KEYS[1])}
`

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

    // Single atomic round-trip: attempt SET NX; if taken, returns existing value.
    const [acquired, existing] = (await this.redis.client.eval(
      OCCUPY_SCRIPT,
      1,
      redisKey,
      PENDING_SENTINEL,
      String(ttlSeconds),
    )) as [number, string | null | false]

    if (acquired === 1) {
      return { status: 'acquired' }
    }

    // PENDING_SENTINEL means another process holds the slot but hasn't committed yet.
    if (!existing || existing === PENDING_SENTINEL) {
      return { status: 'pending' }
    }

    return { status: 'duplicate', taskId: existing }
  }

  /** Commits the taskId into the occupied slot (uses KEEPTTL to preserve expiry). */
  async commitResult(key: string, taskId: string): Promise<void> {
    const redisKey = `${KEY_PREFIX}:${key}`
    // KEEPTTL requires Redis >= 6.0; preserves the original slot TTL on overwrite.
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
