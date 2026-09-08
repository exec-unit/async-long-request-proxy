# ADR-005: API and Worker as Separate Processes from One Codebase

Status: Accepted<br>
Date: 2026-09-02<br>
Deciders: exec-unit

---

## Context

The system has two fundamentally different runtime profiles:

- API: Handles short-lived HTTP requests. Scaling axis is CPU and concurrent connections.
- Worker: Processes BullMQ jobs, makes outbound HTTP calls, runs cron sweepers. Scaling axis is queue depth.

A single-process deployment cannot scale these independently and conflates two separate failure domains.

---

## Decision

One codebase, two separate entry points with distinct NestJS module compositions.

`src/main.ts` bootstraps `AppModule` via `NestFactory.create()` - an HTTP server with controllers, guards, and middleware.

`src/worker.ts` bootstraps `WorkerModule` via `NestFactory.createApplicationContext()` - no HTTP server, only BullMQ processors and repeatable jobs.

Both entry points are built from the same `dist/` output. The entrypoint is differentiated by npm script:

```json
"start":  "node dist/src/main.js"
"worker": "node dist/src/worker.js"
```

In Docker, two images are built from the same Dockerfile with different `CMD` instructions. In Kubernetes, they run as separate `Deployment` resources scaled independently (HPA for API, KEDA for Worker).

---

## Consequences

### Positive

- Independent scaling - API scales by request rate (HPA); Worker scales by queue depth (KEDA). A burst of executor callbacks does not force API scale-out.
- Isolated failure domains - a Worker crash does not affect the API's ability to accept new tasks. In-flight BullMQ jobs are safe in Redis and re-queued on restart.
- Worker shutdown is graceful - `enableShutdownHooks()` + BullMQ `worker.close()` drains the current job before exiting on SIGTERM.
- Single build artifact - CI builds once; both processes run from the same `dist/`.

### Negative / Trade-offs

- Module composition requires discipline - worker-only modules must not be imported into `AppModule` and vice versa. This is enforced by convention, not the build system. A misplaced import can instantiate unnecessary connections or consumers in the wrong process.
- Shared Redis and Postgres - both processes connect to the same stores. A Redis outage affects both simultaneously. This is by design; the trade-off is accepted for simplicity.
