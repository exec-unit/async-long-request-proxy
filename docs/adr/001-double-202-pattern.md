# ADR-001: Double 202 Pattern

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

A proxy that dispatches work to an executor by holding a synchronous HTTP connection open until the executor finishes solves nothing - it moves the long-lived connection from the client-to-proxy leg to the proxy-to-executor leg. Any gateway sitting in front of the proxy still times out, and now the proxy itself holds connections open for the duration of every running task, making it the bottleneck.

The pattern must be fully asymmetric: neither connection in the chain should wait for execution to finish.

SSE connections (`GET /v1/tasks/:id/stream`) are a separate concern - they are intentionally persistent and handled via event sourcing (see [ADR-004](004-sse-event-sourcing.md)).

---

## Decision

Task submission, dispatch, and result push are structured as three independent short-lived HTTP calls.

1. Client to Proxy: `POST /v1/tasks` returns `202 Accepted` with `statusUrl` and `streamUrl`. The connection closes immediately.

2. Worker to Executor: The BullMQ worker POSTs to `executorUrl` with the task payload. The executor responds `202 Accepted` - only an acknowledgement that the task was received and will be processed in the background. The connection closes in ~50ms.

3. Executor to Proxy: When the executor finishes, it makes a separate outbound request to `POST /v1/tasks/:id/result`. This is a new, short-lived connection from executor to proxy.

4. The client retrieves the result via polling, webhook, or SSE.

---

## Consequences

### Positive

- No infrastructure timeout risk on the task submission or dispatch paths, regardless of how long the operation takes.
- The proxy can be placed behind any gateway without timeout configuration adjustments.
- Executors are fully decoupled from the proxy's internal infrastructure - they only need to know the result callback URL.

### Negative / Trade-offs

- Executor implementation complexity increases. The executor must implement a callback pattern rather than a simple synchronous handler.
- Operational visibility requires polling or SSE. There is no single HTTP response containing the result.
- Executors must be idempotent. Because dispatch can be retried (see [ADR-007](007-dispatch-error-strategy.md)), the executor may receive the same `taskId` more than once.

### Constraints this creates

- Executors must respond `202` to the dispatch POST within `requestTimeoutMs` (default 10 s). Result data in the response body is ignored by design - `HttpRetryService` does not read it.
