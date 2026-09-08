# ADR-004: SSE via Event Sourcing + Redis Pub/Sub

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

Clients need real-time task lifecycle updates without polling. Server-Sent Events (SSE) is the natural fit - unidirectional, HTTP/1.1-compatible, browser-native.

However, SSE has a fundamental reliability problem: if the client disconnects and reconnects, events emitted during the gap are lost. The browser SSE API provides `Last-Event-ID` as a reconnect hint, but the server must implement the replay logic.

A naive SSE implementation using only Redis Pub/Sub:

- Delivers live events correctly
- Loses all events that occurred between disconnect and reconnect
- Has no answer to "what happened while you were gone?"

An implementation using only database polling:

- Can replay history
- Has latency equal to the polling interval
- Does not scale to thousands of connections

The challenge is combining both: zero-latency live delivery and reliable reconnect replay.

---

## Decision

SSE is implemented with event sourcing in Postgres combined with Redis Pub/Sub for live fan-out, with a carefully ordered connection sequence to eliminate race conditions.

### Event sourcing

Every state change (progress, completed, failed, cancelled) is written as an immutable row to the `task_events` table with a monotonic `seq` counter per task. This is the persistent record that enables replay.

The `seq` column becomes the SSE `id` field, which browsers automatically send back as `Last-Event-ID` on reconnect.

### Connection sequence (subscribe-then-replay)

The ordering is critical:

```
1. Subscribe to Redis channel `task:{id}`
   -> buffer any incoming messages (history not yet loaded)

2. Query DB: SELECT * FROM task_events WHERE task_id = ? AND seq > {afterSeq}
   -> replay these to the client

3. Drain the live buffer, skipping events with seq <= highestHistorySeq (already sent)

4. Forward subsequent Pub/Sub messages in real time
```

Why subscribe before querying: if the order were reversed (query then subscribe), events published between the end of the query and the subscribe call would be permanently missed. By subscribing first and buffering, we guarantee coverage with no gap.

### Isolated subscriber connection

ioredis enters a subscriber-only mode when `.subscribe()` is called - it can no longer send regular commands on the same connection. Therefore, each SSE connection creates its own isolated ioredis client via `redis.createIsolatedClient()`. This is torn down when the SSE connection closes.

### Heartbeat

A 25-second `ping` event (empty data, type `ping`) is sent periodically. This prevents reverse proxies (nginx `proxy_read_timeout`, AWS ALB idle timeout) from silently closing quiet SSE connections.

### Buffer overflow guard

If the history query takes too long and more than 500 live events arrive in the buffer, the stream is closed with an error. The client is expected to reconnect, at which point the full history is available. This caps memory usage per connection.

---

## Consequences

### Positive

- Zero event loss on reconnect - `Last-Event-ID` replay is reliable for the task's entire lifetime (limited by data retention policy).
- Zero-latency live delivery - Redis Pub/Sub delivers events in milliseconds, not polling intervals.
- No race window - subscribe-before-query ordering is explicitly documented and enforced in code.
- Scales to many connections - each connection only holds an ioredis subscriber and some buffered events. The DB query runs once at connection setup.

### Negative / Trade-offs

- One ioredis connection per active SSE client - at 2000 concurrent connections, this is 2000 Redis connections. This was validated in the k6 load test (`benchmarks/k6/load-sse.ts`). Redis can handle this, but connection limits must be configured appropriately.
- Buffer overflow terminates the stream - if the DB is slow and more than 500 events arrive in flight, the client must reconnect. In practice, this only occurs under pathological load or DB degradation.
- `task_events` grows unbounded during task lifetime - mitigated by the data retention sweeper, which deletes events when their parent task is pruned.
- No server-side fan-out deduplication - if 100 clients subscribe to the same task, Redis delivers the message 100 times (once per subscriber). For tasks with many subscribers, a shared Observable with multicasting (RxJS `shareReplay`) could reduce Redis traffic, but this was not implemented to keep the code simple.
