# Operations Guide

## Table of Contents

- [Deployment](#deployment)
- [Monitoring](#monitoring)
- [Scaling](#scaling)
- [Database](#database)
- [Redis](#redis)
- [Timeout Sweeper](#timeout-sweeper)
- [Logs](#logs)
- [Common Issues](#common-issues)

---

## Deployment

### Docker Compose

```bash
make up
make migrate
make down
make restart
make logs
make ps
```

`make env-check` copies `.env.example` to `.env` and `deploy/.env.infra.example` to `deploy/.env.infra` if either is missing.

### Kubernetes (Helm) - local kind cluster

```bash
make kind-up
make k8s-deploy
```

Iterate on changes:

```bash
make k8s-redeploy
```

Tail logs for a component:

```bash
make k8s-logs C=api
make k8s-logs C=worker
```

### Kubernetes (Helm) - remote cluster

```bash
helm repo add async-proxy oci://ghcr.io/exec-unit/charts
helm install async-proxy async-proxy/async-long-request-proxy \
  --set secret.databaseUrl="postgres://..." \
  --set secret.redisHost="redis-host" \
  --set secret.proxyApiKey="your-key"
```

Helm values reference:

| Path                           | Default  | Description                                    |
| ------------------------------ | -------- | ---------------------------------------------- |
| `image.tag`                    | `latest` | Docker image tag                               |
| `api.replicaCount`             | `2`      | API pod count                                  |
| `api.hpa.enabled`              | `true`   | Enable HPA for API (scales by CPU)             |
| `api.hpa.maxReplicas`          | `10`     | Max API replicas                               |
| `worker.replicaCount`          | `1`      | Worker pod count                               |
| `worker.keda.enabled`          | `true`   | Enable KEDA for worker (scales by queue depth) |
| `worker.keda.redisQueueLength` | `50`     | Queue depth threshold per worker replica       |
| `secret.existingSecret`        | `""`     | Use an existing k8s Secret (Vault / ESO)       |

The Helm chart includes a pre-install `migrate` Job that runs DB migrations before pods start, separate `Deployment` manifests for API and Worker, and a KEDA `ScaledObject` for the Worker.

See [`deploy/helm/async-long-request-proxy/values.yaml`](../deploy/helm/async-long-request-proxy/values.yaml) for the full reference.

---

## CI/CD

CI (`.github/workflows/ci.yml`): runs on every push/PR to `main` - lint, typecheck, unit tests, E2E tests, and Trivy security scan.

Publish (`.github/workflows/publish.yml`): triggered on `v*` tags - builds and pushes Docker images to GHCR, packages and pushes the Helm chart as an OCI artifact, creates a GitHub Release with a conventional changelog.

Release process:

1. Bump version in `package.json`
2. `git tag v1.x.x && git push --tags`

The publish workflow validates that the tag is on `main` and matches `package.json` version before building.

---

## Monitoring

### Health endpoints

| Endpoint            | Use case                   | Returns                                                  |
| ------------------- | -------------------------- | -------------------------------------------------------- |
| `GET /health/live`  | Kubernetes liveness probe  | Always `200 { status: "ok" }` if process is alive        |
| `GET /health/ready` | Kubernetes readiness probe | `200` if Postgres + Redis are reachable; `503` otherwise |
| `GET /metrics`      | Prometheus scrape target   | `text/plain` Prometheus format                           |

Configure the liveness probe to use `/health/live` and the readiness probe to use `/health/ready`. The proxy is removed from the load balancer endpoint set when readiness fails.

### Prometheus metrics

The proxy exposes default Node.js process metrics via `prom-client` at `/metrics`.

Metrics to alert on:

- `process_heap_used_bytes` on the Worker process: indicates SSE client accumulation if rising steadily
- `http_request_duration_seconds` on `POST /v1/tasks` p99: should be under 500ms under normal load
- BullMQ queue depth (via Redis `LLEN` or KEDA metrics): triggers Worker autoscaling

---

## Scaling

### API (HTTP traffic)

The API process is stateless and scales horizontally. Use the Kubernetes HPA:

```yaml
api:
  hpa:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 80
```

For SSE-heavy workloads, consider using `targetMemoryUtilizationPercentage` alongside CPU, since each active SSE connection holds an ioredis subscriber.

### Worker (queue depth)

The Worker scales based on BullMQ queue depth using KEDA:

```yaml
worker:
  keda:
    enabled: true
    minReplicaCount: 1
    maxReplicaCount: 10
    redisQueueLength: 50
```

When the combined queue depth of `dispatch` + `webhook` + `cancel` queues exceeds `redisQueueLength x currentReplicas`, KEDA adds a replica.

The Worker can scale to 0 in low-traffic periods with KEDA, but the maintenance cron jobs (timeout sweeper, data retention) require at least 1 replica. Set `minReplicaCount: 1` for production.

---

## Database

### Migrations

Migrations are managed by `drizzle-kit` and run from the `migrate` init container in Kubernetes:

```bash
# Local
make migrate

# Docker Compose
docker compose run --rm migrate

# Kubernetes (runs automatically as a pre-install Helm Job)
helm install async-proxy ... --wait
```

Migration files are in `src/database/drizzle/migrations/`. They are append-only - never edit an existing migration.

### Generating a new migration

Inspects schema changes and generates a new `.sql` migration file:

```bash
pnpm db:generate
```

Applies pending migrations to the DB:

```bash
pnpm db:migrate
```

### Indexes

The schema includes purpose-built indexes:

| Index                                | Purpose                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `tasks_status_idx`                   | General status queries (get all PENDING)                                                                  |
| `tasks_sweeper_idx`                  | Partial index on `expires_at WHERE status IN ('PENDING','PROCESSING')` - hot path for the timeout sweeper |
| `tasks_idempotency_key_idx`          | Unique partial index (only for non-null keys)                                                             |
| `task_events_task_id_seq_unique_idx` | SSE replay queries, prevents duplicates                                                                   |
| `task_events_created_at_idx`         | Data retention range queries                                                                              |

Do not drop `tasks_sweeper_idx` - without it, the sweeper performs a full table scan on every cron cycle.

### Data retention

Terminal tasks and their events are deleted by the data retention cron job:

- Controlled by `DATA_RETENTION_DAYS` (default: 30)
- Schedule controlled by `DATA_RETENTION_CRON` (default: `0 3 * * *` - 03:00 UTC daily)
- Deletes in batches of 500 rows to prevent lock contention
- Only terminal tasks (`COMPLETED`, `FAILED`, `CANCELLED`) are pruned - in-flight tasks are never deleted

To adjust:

```bash
DATA_RETENTION_DAYS=7
DATA_RETENTION_CRON=0 2 * * *
```

---

## Redis

### Connection modes

Standalone (default):

```env
REDIS_HOST=my-redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=secret
```

Cluster mode:

```env
REDIS_CLUSTER_MODE=true
REDIS_CLUSTER_NODES=redis-1:6379,redis-2:6379,redis-3:6379
```

Cross-field validation: `REDIS_CLUSTER_MODE=true` without `REDIS_CLUSTER_NODES` aborts startup with an error.

### Redis requirements

- Redis >= 6.0 (for `KEEPTTL` support in idempotency commits)
- `maxRetriesPerRequest: null` is set on BullMQ connections - required by BullMQ

### Redis data

| Key pattern         | Purpose                           | TTL                     |
| ------------------- | --------------------------------- | ----------------------- |
| `idempotency:{key}` | Idempotency slot                  | 24 hours                |
| `bull:{queue}:*`    | BullMQ job data                   | Managed by BullMQ       |
| `task:{taskId}`     | Redis Pub/Sub channel (ephemeral) | None (channel, not key) |

BullMQ retains completed jobs for 1 hour and keeps the last 100 failed jobs (configurable in `BullMqAdapter`).

---

## Timeout Sweeper

The sweeper is a BullMQ repeatable job registered by `TimeoutSweeperProcessor` at Worker startup.

- Default schedule: every minute (`* * * * *` UTC)
- Configurable via `TIMEOUT_SWEEPER_CRON`
- Safe for multi-replica Workers: `upsertJobScheduler` is idempotent; BullMQ elects one runner per cycle
- Batch size: 500 tasks per sweep; loops until no expired tasks remain

If frequent timeout sweeper warnings appear in logs, executors may be failing silently. Check:

1. Is `executorUrl` reachable from the Worker?
2. Is `timeoutSeconds` appropriate for the workload?
3. Are executors pushing results back within the timeout?

---

## Logs

Logs are structured JSON (Pino). Fields:

| Field     | Description                                  |
| --------- | -------------------------------------------- |
| `level`   | `trace`, `debug`, `info`, `warn`, `error`    |
| `context` | NestJS component name (e.g., `TasksService`) |
| `msg`     | Human-readable message                       |
| `taskId`  | Appears in task-related log lines            |

In `development` mode, `pino-pretty` is available for human-readable output:

```bash
pnpm start:dev | pnpm pino-pretty
```

Log levels to alert on:

- `error` - always alert
- `warn` with `Timeout sweep: expired` - executors may be failing
- `warn` with `Webhook delivery failed` - the webhook endpoint may be down
- `error` with `Failed to revert task` - DB outage during dispatch

---

## Common Issues

### Task stuck in PENDING

The dispatch job may have failed before the task transitioned to PROCESSING. Check:

1. Worker logs for `Failed to enqueue dispatch`
2. BullMQ failed jobs (via Redis CLI: `LRANGE bull:dispatch:failed 0 -1`)
3. Executor connectivity from Worker: can the Worker reach `executorUrl`?

The timeout sweeper will eventually fail the task (within `timeoutSeconds + sweep_interval`).

### Task stuck in PROCESSING

The executor received the dispatch but never pushed a result. Possibilities:

1. Executor crashed without sending a result
2. Executor's result POST is failing (check executor logs)
3. Network partition between executor and proxy

The timeout sweeper will fail the task after `expiresAt`.

### SSE stream not receiving events

1. Is the reverse proxy stripping SSE headers? Check that `X-Accel-Buffering: no` and `Cache-Control: no-cache` pass through.
2. Is the proxy idle timeout shorter than the heartbeat interval (25 s)? Increase the proxy timeout or reduce `HEARTBEAT_INTERVAL_MS`.
3. Is `Last-Event-ID` being passed on reconnect? The browser handles this automatically, but custom clients must send it.

### Idempotency not working (duplicate tasks created)

1. Is `idempotencyKey` exactly the same string in both requests (case-sensitive)?
2. Is the first request completing within 24 hours? The TTL window is fixed.
3. Check Redis for the key: `GET idempotency:{your-key}`. If empty, the slot expired.

### Redis Cluster errors at startup

`REDIS_CLUSTER_MODE=true` requires `REDIS_CLUSTER_NODES` to be set. Missing nodes aborts startup. Verify the env var format: `host1:port1,host2:port2`.
