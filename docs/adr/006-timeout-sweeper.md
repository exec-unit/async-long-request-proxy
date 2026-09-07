# ADR-006: Timeout Sweeper with FOR UPDATE SKIP LOCKED

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

Tasks have a configurable `timeoutSeconds`. If an executor never pushes a result (crash, network partition, bug), the task remains in `PROCESSING` indefinitely. The system needs a mechanism to detect and fail these "zombie" tasks.

Options considered:

1. Per-task scheduled job - create a BullMQ delayed job at task creation time that fires after `timeoutSeconds`. Clean semantics but creates N jobs for N tasks; BullMQ delayed jobs are stored in Redis sorted sets and checked on every cycle, scaling poorly with task volume.

2. Database-level timeout (e.g., PostgreSQL `now() + interval` generated column + trigger) - complex, requires trigger maintenance, and triggers cannot atomically insert events and publish to Redis.

3. Periodic sweeper - a cron job that scans for tasks past their deadline and fails them in a batch. Simple, predictable, requires no per-task scheduling.

---

## Decision

A BullMQ repeatable job (`TimeoutSweeperProcessor`) runs on a configurable cron schedule (default: every minute) and batch-expires overdue tasks.

### Sweep algorithm

```
LOOP:
  BEGIN TRANSACTION
    SELECT id FROM tasks
    WHERE status IN ('PENDING', 'PROCESSING') AND expires_at < NOW()
    LIMIT 500
    FOR UPDATE SKIP LOCKED

    UPDATE tasks SET status = 'FAILED', error = {...}, completed_at = NOW()
    WHERE id IN (above ids)
    RETURNING id

    INSERT INTO task_events (task_id, seq, event_type, ...)
    SELECT ... ROW_NUMBER() OVER (PARTITION BY task_id) ...
    FROM unnest(expired_ids)
  COMMIT

  PUBLISH to Redis per expired task

  IF expired < 500: break
```

### Design choices

`FOR UPDATE SKIP LOCKED`: Prevents lock contention when multiple Worker replicas run the sweeper simultaneously. Each replica picks up a different batch of rows without waiting. Without `SKIP LOCKED`, replicas would queue behind each other for the same rows, effectively serializing all sweep operations.

Batch size 500 + loop: A single sweep may need to expire thousands of tasks (e.g., after a Redis outage where many tasks timed out). Processing in batches of 500 prevents long-held row locks that would block the API, WAL bloat from a single massive UPDATE, and transaction memory pressure.

`attempts: 1` on the repeatable job: Retrying the entire sweep after a partial failure could double-fail tasks that were already transitioned in the first attempt (the conditional UPDATE would find no rows to update for already-failed tasks, so this is actually safe, but the event insertions would create duplicates). Keeping `attempts: 1` avoids the complexity of idempotent event insertion.

`upsertJobScheduler` is idempotent: Multiple Worker replicas calling `upsertJobScheduler` with the same key register only one schedule. BullMQ elects a single worker to run each scheduled invocation.

Bulk event insertion with `ROW_NUMBER()`: Rather than inserting one event per expired task (N round-trips), the sweeper inserts all events in a single SQL statement using `unnest()` + `ROW_NUMBER() OVER (PARTITION BY task_id)` to assign monotonically increasing per-task sequence numbers without per-row advisory locks.

---

## Consequences

### Positive

- Simple operational model - one cron job, no per-task scheduled jobs in Redis.
- Handles large backlogs - the loop continues until no expired tasks remain.
- Concurrency-safe - `FOR UPDATE SKIP LOCKED` allows safe parallel sweeping across replicas.
- Notifies SSE clients - expired tasks publish to their Redis channel so live SSE streams terminate cleanly rather than being abandoned.
- Configurable frequency - `TIMEOUT_SWEEPER_CRON` defaults to every minute but can be reduced for lower-latency timeout detection.

### Negative / Trade-offs

- Detection latency - tasks are not expired at the exact moment they time out; they are expired at the next sweep cycle. With the default 1-minute cron, a task may remain in `PROCESSING` for up to `timeoutSeconds + 60` seconds before being failed.
- `expiresAt` is set at PROCESSING time, not at creation time. This is intentional - the timeout budget starts when the executor accepts the task, not when the client submitted it. But it means a task can remain `PENDING` in the queue for longer than `timeoutSeconds` without triggering the sweeper (the sweeper only looks at `PENDING` tasks whose `expiresAt` has passed; `expiresAt` is also set at creation time as an initial deadline, then updated at PROCESSING time).
- Cron runs even when there is nothing to expire - a minor Redis/Postgres overhead per sweep cycle. Acceptable given the simplicity gain.
