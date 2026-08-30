import http from 'k6/http'
import { check } from 'k6'

export const options = {
  scenarios: {
    constant_request_rate: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 100,
      maxVUs: 500,
    },
  },
}

const BASE_URL = __ENV['API_URL'] || 'http://localhost:8080'
const API_KEY = __ENV['PROXY_API_KEY'] || ''

export default function () {
  const payload = JSON.stringify({
    type: 'benchmark',
    executorUrl: 'http://example.com/exec',
    idempotencyKey: `k6-${String(__VU)}-${String(__ITER)}`,
  })

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
  }

  const res = http.post(`${BASE_URL}/v1/tasks`, payload, params)

  check(res, {
    'status is 202': (r) => r.status === 202,
    'has taskId': (r) => Boolean(r.json('taskId')),
  })
}
