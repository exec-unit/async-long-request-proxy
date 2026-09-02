# Executor Integration Guide

The executor is the service that performs the actual long-running work. This document describes the HTTP contract between the proxy and an executor.

---

## How Executors Fit In

The proxy owns task lifecycle. The executor owns business logic. They interact through two HTTP calls:

```
Proxy Worker -> POST {executorUrl}          (task dispatch, ~50ms connection)
Executor     -> POST /v1/tasks/:id/result   (when done, push result back)
```

No HTTP connection is held open during processing.

---

## Step 1: Implement the Dispatch Endpoint

The executor must expose an endpoint that the proxy worker will call when a task is ready.

```
POST {executorUrl}
Authorization: Bearer {callbackToken}
Content-Type: application/json

{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": { ...whatever the client sent in POST /tasks }
}
```

The endpoint must:

1. Respond `202 Accepted` immediately (within a few seconds)
2. Start the actual work asynchronously (background thread, worker process, BullMQ job, etc.)
3. Not include the result in the response body - it is ignored

```typescript
app.post('/execute', (req, res) => {
  const { taskId, payload } = req.body
  const callbackToken = req.headers.authorization?.replace('Bearer ', '')

  processInBackground(taskId, payload, callbackToken)

  res.status(202).send()
})
```

### Handling duplicate dispatches

The proxy may dispatch the same `taskId` more than once due to infrastructure retries (see [ADR-007](adr/007-dispatch-error-strategy.md)). The executor must be idempotent - receiving the same `taskId` twice must not cause duplicate side effects.

```typescript
async function processInBackground(taskId, payload, token) {
  if (await isAlreadyRunning(taskId)) return

  // do the actual work
}
```

---

## Step 2: Push the Result

When the executor finishes, push the result back to the proxy:

```
POST {proxyBaseUrl}/v1/tasks/{taskId}/result
Authorization: Bearer {callbackToken}
Content-Type: application/json
```

On success:

```json
{
  "status": "completed",
  "result": {
    "output": "any JSON you want",
    "processingTimeMs": 45000
  }
}
```

On failure:

```json
{
  "status": "failed",
  "error": {
    "code": "PROCESSING_FAILED",
    "message": "Human-readable description",
    "details": { "originalError": "..." }
  }
}
```

The proxy will:

- Transition the task to `COMPLETED` or `FAILED`
- Write the result/error to the DB
- Publish an SSE event so live clients get notified
- Trigger a webhook delivery if `webhookUrl` was set

Expected response codes:

- `204 No Content` - result accepted
- `401 Unauthorized` - invalid or missing `callbackToken`
- `404 Not Found` - `taskId` not found
- `409 Conflict` - task is not in `PROCESSING` state (already completed, cancelled, or expired)

The `409` case happens if the timeout sweeper expired the task during processing. Log it and discard the result.

---

## Step 3: Report Progress (Optional)

Incremental progress updates (0-100) can be pushed while processing:

```
PATCH {proxyBaseUrl}/v1/tasks/{taskId}/progress
Authorization: Bearer {callbackToken}
Content-Type: application/json

{ "progress": 42 }
```

Progress updates:

- Update the `progress` field in the DB
- Emit a `progress` SSE event to live clients
- Do not change task status

---

## Step 4: Handle Cancellation (Optional)

If `cancelUrl` is set when creating the task, the proxy will call it when `DELETE /v1/tasks/:id` is invoked:

```
POST {cancelUrl}
Authorization: Bearer {callbackToken}
Content-Type: application/json

{ "taskId": "uuid" }
```

The endpoint should stop the in-progress work. Respond `200` or `202`. The task is already `CANCELLED` in the proxy - this notification is best-effort.

Alternatively, the executor can poll `GET /v1/tasks/:id` and check `status === 'CANCELLED'` between processing steps. Both approaches are supported.

---

## Minimal Integration Example

```typescript
import axios from 'axios'

const PROXY_BASE_URL = 'http://localhost:8080'

app.post('/execute', async (req, res) => {
  const { taskId, payload } = req.body as { taskId: string; payload: unknown }
  const token = req.headers.authorization?.slice(7) ?? ''

  res.status(202).send()

  setImmediate(async () => {
    try {
      const result = await doHeavyWork(payload)

      await axios.post(
        `${PROXY_BASE_URL}/v1/tasks/${taskId}/result`,
        { status: 'completed', result },
        { headers: { Authorization: `Bearer ${token}` } },
      )
    } catch (err) {
      await axios.post(
        `${PROXY_BASE_URL}/v1/tasks/${taskId}/result`,
        {
          status: 'failed',
          error: { code: 'WORK_FAILED', message: String(err) },
        },
        { headers: { Authorization: `Bearer ${token}` } },
      )
    }
  })
})
```

---

## Checklist

- [ ] Dispatch endpoint responds `202` within the proxy's `requestTimeoutMs` (default: 10 s)
- [ ] Work runs asynchronously after the `202` response
- [ ] Executor is idempotent on the same `taskId`
- [ ] Result is pushed to `POST /v1/tasks/:id/result` when done
- [ ] `callbackToken` is stored and sent with every callback
- [ ] `409` on result push is handled gracefully (task expired)
- [ ] (Optional) Progress updates via `PATCH /v1/tasks/:id/progress`
- [ ] (Optional) Cancel endpoint at `cancelUrl`
