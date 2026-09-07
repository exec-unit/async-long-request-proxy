# ADR-008: Callback Token Security - Per-Task UUID, Constant-Time Comparison

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

Executor callbacks (`POST /v1/tasks/:id/result`, `PATCH /v1/tasks/:id/progress`) must be authenticated. Without authentication, any party that knows a `taskId` could push a fake result, corrupt task state, or trigger unauthorized webhook deliveries.

A shared API key (one key for all executors) creates a single point of compromise: if the key leaks from any executor, all tasks are vulnerable and rotation requires coordinated updates across all executors. A per-task token scopes the blast radius to a single task.

---

## Decision

A per-task `callbackToken` (UUID v4) is generated at task creation time and stored in `tasks.callback_token`.

### Token lifecycle

1. `POST /v1/tasks` - `randomUUID()` stored as `tasks.callback_token`
2. `DispatchProcessor` - `POST executorUrl` with `Authorization: Bearer {callbackToken}`
3. Executor stores or passes the token through and uses it on callback
4. `CallbackAuthGuard` validates the token on `POST /result` and `PATCH /progress`

### Timing-safe validation

```typescript
const a = Buffer.alloc(maxLen)
const b = Buffer.alloc(maxLen)
providedBuf.copy(a)
storedBuf.copy(b)
const match = timingSafeEqual(a, b) && providedBuf.length === storedBuf.length
```

Both buffers are padded to the same fixed length before comparison. The length check is separate from `timingSafeEqual` to avoid leaking length information via short-circuit.

### Token visibility

`callbackToken` is stripped from every `GET /v1/tasks/:id` response. It appears only in the dispatch POST body - never in polling responses, logs, or webhooks.

---

## Consequences

### Positive

- Task-scoped authorization - a leaked token for task A cannot be used to manipulate task B.
- No shared secrets to rotate - tokens are disposable; each task has its own.
- Timing attack prevention - `timingSafeEqual` eliminates the vulnerability where an attacker can determine token prefix matches via response latency.
- No additional auth infrastructure - no JWT signing keys, no OAuth, no token registry beyond the tasks table.

### Negative / Trade-offs

- Token is stored in plaintext in Postgres. An attacker with DB read access can extract tokens. Hashing at rest would require an additional secret and a different comparison flow; this was not implemented given the stated threat model (internal network, DB access controlled by credentials and network policies).
- UUID v4 has 122 bits of randomness. Sufficient for an internal authentication token, but weaker than a 256-bit random value if the threat model changes.
- No mid-execution token rotation. If a token is suspected compromised, the only option is to cancel the task.
