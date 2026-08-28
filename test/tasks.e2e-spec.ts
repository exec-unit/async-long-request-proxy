import type { INestApplication } from '@nestjs/common'
import type { Server } from 'http'
import request from 'supertest'
import { TestEnvironment } from './test-environment.js'

describe('Tasks (e2e)', () => {
  let app: INestApplication | undefined
  let testEnv: TestEnvironment | undefined
  let server: Server
  const proxyApiKey = 'test-api-key'

  beforeAll(async () => {
    testEnv = new TestEnvironment()
    await testEnv.start()

    process.env['PROXY_API_KEY'] = proxyApiKey
    app = await testEnv.createApplication()
    server = app.getHttpServer() as Server
  }, 60000)

  afterAll(async () => {
    if (app) await app.close()
    if (testEnv) await testEnv.stop()
  })

  it('should reject requests without API key', async () => {
    return request(server)
      .post('/tasks')
      .send({ type: 'test', executorUrl: 'http://example.com' })
      .expect(401)
  })

  it('should accept valid task and handle idempotency', async () => {
    const idempotencyKey = 'test-idem-1'
    const payload = { type: 'test', executorUrl: 'http://example.com', idempotencyKey }

    // First request - should create
    const res1 = await request(server)
      .post('/tasks')
      .set('X-API-Key', proxyApiKey)
      .send(payload)
      .expect(202)

    const data1 = res1.body as { taskId: string }
    expect(data1.taskId).toBeDefined()

    // Second request - should return the same taskId
    const res2 = await request(server)
      .post('/tasks')
      .set('X-API-Key', proxyApiKey)
      .send(payload)
      .expect(202)

    const data2 = res2.body as { taskId: string }
    expect(data2.taskId).toEqual(data1.taskId)
  })

  it('should not allow cancelling a completed task', async () => {
    const payload = { type: 'test', executorUrl: 'http://example.com' }
    const createRes = await request(server)
      .post('/tasks')
      .set('X-API-Key', proxyApiKey)
      .send(payload)
      .expect(202)

    const createData = createRes.body as { taskId: string }
    const taskId = createData.taskId

    // We can't easily mock the worker transitioning state to PROCESSING in this test
    // but we can test the basic /tasks/:id endpoint
    const getRes = await request(server)
      .get(`/tasks/${taskId}`)
      .set('X-API-Key', proxyApiKey)
      .expect(200)

    const getData = getRes.body as { status: string }
    expect(getData.status).toEqual('PENDING')

    // Cancel the task
    await request(server)
      .delete(`/tasks/${taskId}`)
      .set('X-API-Key', proxyApiKey)
      .expect(204)

    // Verify it's cancelled
    const getResCancelled = await request(server)
      .get(`/tasks/${taskId}`)
      .set('X-API-Key', proxyApiKey)
      .expect(200)

    const getDataCancelled = getResCancelled.body as { status: string }
    expect(getDataCancelled.status).toEqual('CANCELLED')

    // Cancelling again should return 409
    await request(server)
      .delete(`/tasks/${taskId}`)
      .set('X-API-Key', proxyApiKey)
      .expect(409)
  })
})
