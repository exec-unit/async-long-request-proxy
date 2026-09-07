# ADR-007: Dispatch Error Strategy - Revert vs. Permanent Failure

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

When the `DispatchProcessor` attempts to `POST` the task to `executorUrl`, several failure modes are possible:

1. Executor rejects the request (4xx response) - the executor is reachable but refuses the task. This is a permanent failure: retrying the same payload to the same URL will produce the same result.

2. Executor is temporarily unavailable (5xx, network error) - transient failure; the executor may recover. Retry makes sense.

3. Infrastructure error (Postgres down, Redis timeout) after the task was already transitioned to `PROCESSING` - the task is stuck in `PROCESSING` with no executor running. BullMQ will retry the job, but the next attempt will find the task already in `PROCESSING` and skip it (because `updateStatus('PENDING', 'PROCESSING')` returns null for non-PENDING tasks).

Case 3 requires special handling to avoid leaving tasks permanently stuck.

---

## Decision

The `DispatchProcessor` uses a differentiated error strategy based on error type.

### HTTP errors (4xx, exhausted retries on 5xx)

```typescript
catch (err) {
  if (err instanceof NonRetryableError || err instanceof DispatchFailedError) {
    await tasksRepo.updateStatus(taskId, 'PROCESSING', 'FAILED', {
      completedAt: new Date(),
      error: { code, message: err.message },
    })
    return
  }
}
```

The job is completed (not re-thrown) so BullMQ does not mark it as failed or retry it. The task is already in a terminal state.

### Infrastructure errors after PROCESSING transition

```typescript
await tasksRepo.updateStatus(taskId, 'PROCESSING', 'PENDING', {
  processingStartedAt: null,
  expiresAt: null,
})
throw err
```

The task is reverted to `PENDING` before re-throwing. BullMQ's retry then picks it up from the beginning.

### Known limitation

If the HTTP POST to `executorUrl` succeeds but the subsequent `PROCESSING -> COMPLETED` DB update fails, the task is reverted to `PENDING`. BullMQ will retry the dispatch, and the executor receives the same `taskId` again. This is why executors must be idempotent on their side - receiving the same `taskId` twice should not produce duplicate side effects.

---

## Consequences

### Positive

- No stuck tasks - infrastructure errors trigger a revert+retry cycle rather than leaving the task in `PROCESSING` indefinitely.
- No duplicate execution for permanent failures - 4xx errors are terminal; the task fails exactly once.
- BullMQ's retry mechanics are preserved for the recoverable case.

### Negative / Trade-offs

- Executor must be idempotent - this is a documented requirement of the Double 202 contract. It is a reasonable expectation for any HTTP endpoint that may be retried.
- Revert may fail - if the DB is down, the `updateStatus(PROCESSING -> PENDING)` revert also fails. The task remains stuck in `PROCESSING` until the timeout sweeper expires it. This is logged as an error.
- `attempts: 1` on the dispatch job - to prevent BullMQ from re-dispatching a job that already moved the task to `PROCESSING`, the queue option is `{ attempts: 1 }`. Retry is handled by reverting to PENDING (which re-enqueues via the normal creation flow). This is intentional but means there is no automatic BullMQ-level retry for the dispatch job itself.
