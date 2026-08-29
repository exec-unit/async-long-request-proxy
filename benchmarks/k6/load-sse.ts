import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  scenarios: {
    sse_connections: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        // ramp up to 2000 concurrent SSE connections
        { duration: '30s', target: 2000 },
        // hold at peak to measure stable-state memory/CPU
        { duration: '1m', target: 2000 },
        // ramp down
        { duration: '30s', target: 0 },
      ],
    },
  },
}

const BASE_URL = __ENV['API_URL'] || 'http://localhost:8080'
const API_KEY = __ENV['PROXY_API_KEY'] || ''

// Number of tasks to pre-create; VUs round-robin over this pool.
// A non-existent executorUrl keeps tasks in PENDING/queued state
// so SSE connections stay open for the duration of the test.
const TASK_POOL_SIZE = 200

interface SetupData {
  taskIds: string[]
}

/** Pre-create a pool of PENDING tasks before ramping up VUs. */
export function setup(): SetupData {
  const taskIds: string[] = []

  for (let i = 0; i < TASK_POOL_SIZE; i++) {
    const res = http.post(
      `${BASE_URL}/v1/tasks`,
      JSON.stringify({
        type: 'sse-load-test',
        // Points to a non-routable address - keeps the task in PENDING state
        // long enough for the benchmark to hold SSE connections open.
        executorUrl: 'http://192.0.2.1/never-responds',
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
        },
      },
    )

    if (res.status === 202) {
      const body = res.json() as { taskId: string }
      taskIds.push(body.taskId)
    }
  }

  if (taskIds.length === 0) {
    throw new Error(
      'Failed to create any tasks for SSE load test - check API_URL and PROXY_API_KEY',
    )
  }

  return { taskIds }
}

export default function (data: SetupData) {
  // Round-robin task assignment: each VU streams a different task to avoid
  // Redis Pub/Sub fan-out bottlenecks on a single channel.
  const taskId = data.taskIds[__VU % data.taskIds.length]

  const params = {
    headers: {
      Accept: 'text/event-stream',
      'X-API-Key': API_KEY,
    },
    timeout: '120s',
  }

  const res = http.get(`${BASE_URL}/v1/tasks/${taskId}/stream`, params)

  check(res, {
    'status is 200': (r) => r.status === 200,
  })

  sleep(1)
}
