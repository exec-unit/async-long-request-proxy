# ADR-002: State Machine Enforced at the Database Level

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

Task status transitions are critical to system correctness. Invalid transitions - such as moving a `COMPLETED` task back to `PROCESSING`, or failing a `CANCELLED` task - would corrupt the audit trail, trigger incorrect webhook deliveries, and confuse SSE consumers.

Several approaches exist for enforcing state machine transitions:

1. Application-only validation - Check the current status in the service layer before updating. Vulnerable to race conditions: two concurrent workers could both check and find `PENDING`, then both transition to `PROCESSING`.

2. Optimistic locking - Add a `version` column and `WHERE version = N` to updates. Detects conflicts after the fact and requires retry logic.

3. Database-level enforcement - Use `CHECK` constraints for value validity and conditional `UPDATE ... WHERE status = 'EXPECTED_STATUS'` for atomic transitions.

---

## Decision

State machine integrity is enforced at two levels, both in the database.

### Level 1: `CHECK` constraint on value validity

The `tasks_status_check` constraint ensures `status` can only be one of: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED`. The database rejects any other value at write time, regardless of application logic.

```sql
CONSTRAINT tasks_status_check CHECK (
  "status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')
)
```

### Level 2: `CHECK` constraint on cross-column state consistency

The `tasks_valid_state_data` constraint enforces that timestamps are consistent with status:

- `PENDING` - `processingStartedAt IS NULL`, `completedAt IS NULL`
- `PROCESSING` - `processingStartedAt IS NOT NULL`, `completedAt IS NULL`
- `COMPLETED` / `FAILED` - both `processingStartedAt` and `completedAt` are not null
- `CANCELLED` - `completedAt IS NOT NULL`

This means the database rejects a row that claims `status = 'PROCESSING'` but has no `processingStartedAt`, making half-written states structurally impossible.

### Level 3: Conditional `UPDATE` in application code

All state transitions use the pattern:

```sql
UPDATE tasks
SET status = 'PROCESSING', processing_started_at = NOW(), expires_at = NOW() + interval
WHERE id = $taskId AND status = 'PENDING'
RETURNING id
```

If the `WHERE` clause matches zero rows (because another worker already transitioned the task, or it was cancelled), the update returns `null`. The caller treats `null` as a no-op:

```typescript
const task = await this.tasksRepo.updateStatus(taskId, 'PENDING', 'PROCESSING', { ... })
if (!task) {
  return
}
```

This is an atomic read-modify-write without advisory locks.

---

## Consequences

### Positive

- Race-condition-free transitions - the `WHERE status = 'PREVIOUS'` clause is atomic in PostgreSQL's MVCC. Two concurrent workers racing to claim a `PENDING` task will result in exactly one success.
- Defense in depth - database constraints catch bugs in application code that bypass the service layer (direct SQL, migration scripts, admin tools).
- Zero retry logic at the application level - conflicts are silently treated as no-ops, not errors.
- Readable state at a glance - the constraint matrix documents valid state combinations directly in the schema.

### Negative / Trade-offs

- Drizzle ORM generates raw SQL for conditional updates - slightly more verbose than high-level ORM abstractions.
- The `tasks_valid_state_data` check constraint is broad; adding a new status requires updating the constraint definition and running a migration.
- Cross-column `CHECK` constraints that reference `NOW()` cannot be `IMMUTABLE` (PostgreSQL limitation), which is why `expiresAt` is computed in application code and stored explicitly rather than derived from a generated column.
