# async-long-request-proxy

[![CI](https://github.com/exec-unit/async-long-request-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/exec-unit/async-long-request-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/exec-unit/async-long-request-proxy/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-blue)](https://github.com/exec-unit/async-long-request-proxy/blob/main/deploy/docker-compose.yml)
[![Helm](https://img.shields.io/badge/Helm-chart-informational)](https://github.com/exec-unit/async-long-request-proxy/tree/main/deploy/helm)

A proxy service for executing long-running operations - PDF rendering, video transcoding, report generation, batch processing - without coupling the calling service to the execution lifecycle.

The client sends `POST /v1/tasks` and receives a `taskId` immediately. Work is dispatched asynchronously to an executor service. Results come back via polling, webhook, or SSE.

Deployable as a Docker image or via Helm chart. Supports PostgreSQL and Redis clusters as optional configurations. Scales the API and Worker processes independently. Stack-agnostic: communicates with client applications over HTTP.

---

## The Problem

Most backends that implement long-duration operations end up building the same async task infrastructure. The queue is the straightforward part. What tends to get done partially or incorrectly:

- Exactly-once task creation under concurrent client retries. Without a two-phase idempotency mechanism, two simultaneous retries with the same key both pass the existence check before either commits to the database, resulting in duplicate execution.
- State machine correctness across process boundaries. A worker crash mid-processing leaves the task in `PROCESSING` with no one to finish it. Without a conditional atomic `UPDATE` and database-level `CHECK` constraints, the state becomes inconsistent in ways that are hard to detect under normal load.
- Cancellation of in-flight work. Without a cooperative cancellation protocol, there is no reliable way to stop an erroneously launched operation once the executor has started.
- SSE reconnect without data loss. A client that disconnects mid-stream loses all events that arrived during the gap unless the server implements event sourcing with replay semantics (`Last-Event-ID`).
- Recovery from worker crashes after dispatch. If the worker crashes after transitioning a task to `PROCESSING` but before the executor responds, the task is permanently stuck unless the system explicitly reverts state and re-queues.

These bugs tend to surface under load in production - concurrent retries, network partitions, process restarts - not in development.

async-long-request-proxy ships this infrastructure as a deployable service with a fixed, tested implementation of each property.

---

## Why Not Existing Tools

- BullMQ/Celery out of the box provide a queue but not idempotency without race conditions, cooperative cancellation, event-sourced SSE reconnect, or a state machine protected at the DB level. All of that ends up written on top, by hand, in each project.
- Temporal / Trigger.dev / Inngest are full workflow orchestrators: steps, compensations, a DSL, and their own infrastructure. The overhead is not justified when the task is a single long call with a result, not a multi-step business process.
- Increasing proxy timeouts shifts the risk to infrastructure and does not address idempotency, cancellation, or state consistency.

---

## How It Works

Task submission, dispatch, and result push are all short-lived HTTP calls - each closes within a few hundred milliseconds. SSE connections (`GET /v1/tasks/:id/stream`) are intentionally persistent; they are kept alive with heartbeat pings and support reconnect via `Last-Event-ID`.

![Sequence Diagram](docs/assets/readme-sequence-diagram.svg)

The proxy owns task lifecycle only: accept, queue, state transitions, result delivery. Business logic stays in the executor.

---

## Reliability Properties

| Scenario                                 | Mechanism                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Duplicate tasks on client retry          | Two-phase Redis idempotency lock (`SET NX __PENDING__` then commit taskId) with TTL      |
| Worker crash mid-processing              | PostgreSQL conditional `UPDATE` (`PENDING->PROCESSING` atomically) + `CHECK` constraints |
| Task submission / dispatch / result push | All three are short-lived calls; none waits for execution to complete                    |
| Stopping a running operation             | `DELETE /v1/tasks/:id` changes DB state + optional `POST cancelUrl` push to executor     |
| SSE reconnect without data loss          | Event sourcing in Postgres with monotonic `seq`; replay via `Last-Event-ID` header       |
| Executor/webhook unavailability          | Exponential backoff with jitter; terminal failures logged and surfaced via polling       |
| Hung tasks (no result push)              | Configurable timeout sweeper (cron) transitions `PROCESSING -> FAILED` via `expiresAt`   |
| Data accumulation                        | Configurable data retention cron; batch deletes to avoid lock contention                 |

---

## Quick Start

### Option A: Docker image from the registry

Pull and run the published image directly. Requires a running PostgreSQL and Redis.

```bash
docker run -d \
  --name async-proxy-api \
  -p 8080:8080 \
  -e DATABASE_URL="postgres://user:password@host:5432/dbname" \
  -e REDIS_HOST="redis-host" \
  -e REDIS_PORT=6379 \
  ghcr.io/exec-unit/async-long-request-proxy:latest \
  node dist/src/main.js
```

All available variables are documented in the [Configuration](#configuration) section below.

### Option B: Helm chart from the registry

```bash
helm install async-proxy oci://ghcr.io/exec-unit/charts/async-long-request-proxy \
  --set secret.databaseUrl="postgres://..." \
  --set secret.redisHost="redis-host" \
  --set secret.proxyApiKey="your-key"
```

For the full Helm values reference, see [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### Option C: Clone and run locally

Includes PostgreSQL and Redis via Docker Compose - no external infrastructure needed.

```bash
git clone https://github.com/exec-unit/async-long-request-proxy.git
cd async-long-request-proxy
make env-check
make up
```

`make env-check` copies `.env.example` and `deploy/.env.infra.example` to their respective `.env` files if they don't exist. `make up` builds the image, runs migrations, and starts all services.

The API is available at `http://localhost:8080`. Swagger UI: `http://localhost:8080/api/docs` (non-production only).

### Submit a task

```bash
curl -X POST http://localhost:8080/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "my-job",
    "payload": { "input": "data" },
    "executorUrl": "https://your-service.com/execute",
    "webhookUrl": "https://your-service.com/webhook"
  }'
```

Response:

```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "statusUrl": "http://localhost:8080/v1/tasks/550e8400-...",
  "streamUrl": "http://localhost:8080/v1/tasks/550e8400-.../stream"
}
```

Poll `statusUrl` or subscribe to SSE at `streamUrl`.

---

## Public API

All client-facing endpoints require the `X-API-Key` header if `PROXY_API_KEY` is configured.

### `POST /v1/tasks` - Create a task

| Field            | Type   | Required | Description                                           |
| ---------------- | ------ | -------- | ----------------------------------------------------- |
| `type`           | string | yes      | Routing label forwarded verbatim to the executor      |
| `payload`        | object | no       | Opaque data forwarded verbatim to the executor        |
| `executorUrl`    | string | yes      | Where the worker will POST the task (must return 202) |
| `cancelUrl`      | string | no       | Where to POST on `DELETE /tasks/:id`                  |
| `webhookUrl`     | string | no       | Where to POST the final result when done              |
| `idempotencyKey` | string | no       | Exactly-once creation key (scoped to 24 h)            |
| `timeoutSeconds` | number | no       | Business-level timeout in seconds (default: 300)      |

Response `202`: `{ "taskId": "uuid", "statusUrl": "...", "streamUrl": "..." }`

### `GET /v1/tasks/:id` - Get task status

Returns the current task snapshot. `callbackToken` is always stripped from the response.

### `DELETE /v1/tasks/:id` - Cancel a task

Cancels a `PENDING` or `PROCESSING` task. Returns `409` if already in a terminal state.

### `GET /v1/tasks/:id/stream` - SSE stream

Persistent Server-Sent Events connection. Supports `Last-Event-ID` for reconnect-without-loss.

Event types: `progress`, `completed`, `failed`, `cancelled`, `ping`.

---

## Executor Contract

The executor is a service that receives task dispatch via HTTP and pushes results back when done.

See [`docs/EXECUTOR_INTEGRATION.md`](docs/EXECUTOR_INTEGRATION.md) for the full integration guide, including request/response formats, idempotency requirements, progress reporting, and a minimal TypeScript example.

---

## Configuration

All configuration is via environment variables, validated at startup. An invalid or missing required variable aborts startup with a descriptive error.

| Variable               | Default      | Description                                            |
| ---------------------- | ------------ | ------------------------------------------------------ |
| `NODE_ENV`             | `production` | `development`, `production`, or `test`                 |
| `PORT`                 | `8080`       | HTTP port for the API server                           |
| `PROXY_API_KEY`        | _(unset)_    | Static API key; if unset, auth is disabled (fail-open) |
| `DATABASE_URL`         | required     | PostgreSQL connection string (`postgres://...`)        |
| `REDIS_HOST`           | `localhost`  | Redis hostname                                         |
| `REDIS_PORT`           | `6379`       | Redis port                                             |
| `REDIS_PASSWORD`       | _(unset)_    | Redis auth password                                    |
| `REDIS_DB`             | `0`          | Redis logical database index                           |
| `REDIS_CLUSTER_MODE`   | `false`      | Enable Redis Cluster; requires `REDIS_CLUSTER_NODES`   |
| `REDIS_CLUSTER_NODES`  | _(unset)_    | Comma-separated seed nodes (`host:port,host:port`)     |
| `DATA_RETENTION_DAYS`  | `30`         | Days to retain terminal tasks before deletion          |
| `TIMEOUT_SWEEPER_CRON` | `* * * * *`  | Cron (UTC) for the timeout sweeper job                 |
| `DATA_RETENTION_CRON`  | `0 3 * * *`  | Cron (UTC) for the data retention deletion job         |

See [`.env.example`](.env.example) for the full annotated reference.

---

## Development

### Prerequisites

- Node.js >= 22
- pnpm 11.9+
- Docker (for local Postgres/Redis)

### Setup

```bash
pnpm install
make env-check
make up
make migrate
```

API with watch mode:

```bash
pnpm start:dev
```

Worker with watch mode:

```bash
pnpm worker:dev
```

### Testing

```bash
make test
make test-e2e
```

E2E tests use [Testcontainers](https://testcontainers.com/) - real Postgres and Redis containers, no mocking.

---

## Observability

| Endpoint            | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `GET /health/live`  | Liveness probe                           |
| `GET /health/ready` | Readiness probe: checks Postgres + Redis |
| `GET /metrics`      | Prometheus metrics (prom-client)         |

---

## What's Out of Scope

| Feature                             | Reason                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| Multi-step workflow orchestration   | Use Temporal                                                       |
| Business logic execution            | The proxy dispatches work, never executes it                       |
| Admin UI                            | Use Grafana with the provisioned dashboard                         |
| Multi-tenant auth / user management | Pass `organizationId` as an opaque header; manage users externally |
| Email/SMS notifications             | Configure a `webhookUrl`; downstream delivery is out of scope      |
| Redis Sentinel / HA configs         | The proxy connects via standard config; HA setup is external       |
| Terraform / Ansible                 | Infrastructure provisioning is out of scope                        |

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module structure, data flow, and design decisions.

See [`docs/adr/README.md`](docs/adr/README.md) for Architecture Decision Records.

---

## License

[MIT](LICENSE)
