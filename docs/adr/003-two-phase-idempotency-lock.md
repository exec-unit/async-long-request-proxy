# ADR-003: Two-Phase Idempotency Lock in Redis

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

Clients may retry `POST /v1/tasks` if they don't receive a response (network timeout, server restart). Without idempotency, each retry creates a duplicate task - the executor runs the job multiple times and the client sees multiple results.

The standard approach - "check if a task with this key exists, if yes return it, if no create it" - has a TOCTOU (Time of Check, Time of Use) race condition: two concurrent requests with the same key can both pass the check before either has committed to the database.

Possible approaches:

1. Postgres `ON CONFLICT DO NOTHING` - Works for pure DB idempotency but requires the key to be in the same table. Doesn't handle the window between "check Redis" and "return early."
2. Single Redis `SET NX taskId` - The taskId is not known at the time of lock acquisition (it is generated during the DB insert). The final value cannot be written atomically with the initial lock.
3. Two-phase lock with sentinel - Acquire the slot with a placeholder, perform the operation, then replace the placeholder with the result.

---

## Decision

Idempotency uses a two-phase Redis lock with a sentinel value.

### Phase 1: Occupy (atomic SET NX)

A Lua script performs `SET NX` and returns the existing value in a single round-trip:

```lua
local ok = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if ok then return {1, false} end
return {0, redis.call('GET', KEYS[1])}
```

The sentinel value `__PENDING__` is written atomically. It signals "slot is occupied by an in-flight creation."

Possible outcomes:

- `acquired` - slot was free, we have the lock
- `pending` - slot holds `__PENDING__`: another request is creating this task right now - return `409 Conflict` to the client (retry in a moment)
- `duplicate` - slot holds a UUID: the task already exists - return the cached taskId immediately

### Phase 2: Commit (SET KEEPTTL)

After the Postgres INSERT and BullMQ enqueue succeed, the sentinel is replaced with the actual `taskId`:

```
redis.call('SET', key, taskId, 'KEEPTTL')
```

`KEEPTTL` (Redis 6.0+) preserves the original TTL from Phase 1, so the idempotency guarantee remains active for the full 24-hour window.

### Cleanup on failure

If the Postgres INSERT fails, the sentinel is immediately deleted (`DEL key`) so the next retry starts clean. If the commit (Phase 2) fails after a successful insert+enqueue, the slot naturally expires via TTL - this is acceptable because the task was already created and is running correctly.

---

## Consequences

### Positive

- Zero race windows - the Lua script makes SET NX + GET atomic. No two concurrent requests can both see the slot as free.
- Correct response for in-flight creations - the `pending` state allows the client to retry after a brief delay rather than receiving a duplicate or a confusing 409.
- Self-healing via TTL - slot leaks are bounded by the TTL (24 hours). No manual cleanup needed.
- Single round-trip - the Lua script avoids a separate GET call after a failed SET NX.

### Negative / Trade-offs

- Steps 2 and 3 are not in the same transaction (no transactional outbox). A crash between DB INSERT and BullMQ enqueue leaves a task in Postgres with no corresponding job. The timeout sweeper will eventually fail it, but it will remain `PENDING` until then. The trade-off was accepted because implementing a transactional outbox significantly increases complexity.
- `KEEPTTL` requires Redis 6.0+ - Redis 6 was released in April 2020 and is widely available.
- `pending` returns 409, which is semantically slightly awkward - it is not a real conflict, just a temporary in-progress state. The alternative (blocking until commit) would hold an HTTP connection open, violating the Double 202 principle. The client is expected to retry after a short delay.
- 24-hour idempotency window is hardcoded. If a client retries after 24 hours with the same key, a new task will be created. This matches common REST idempotency conventions.
