import type { INestApplication } from '@nestjs/common'
import type { Server } from 'http'
import request from 'supertest'
import { TestEnvironment } from './test-environment.js'
import { TasksRepository } from '#src/modules/tasks/tasks.repository.js'
import { randomUUID } from 'crypto'

describe('Executor Callbacks (e2e)', () => {
  let app: INestApplication | undefined
  let testEnv: TestEnvironment | undefined
  let server: Server
  let tasksRepo: TasksRepository

  beforeAll(async () => {
    testEnv = new TestEnvironment()
    await testEnv.start()
    app = await testEnv.createApplication()
    server = app.getHttpServer() as Server

    tasksRepo = app.get(TasksRepository)
  }, 60000)

  afterAll(async () => {
    if (app) await app.close()
    if (testEnv) await testEnv.stop()
  })

  it('should accept progress update with valid token', async () => {
    const taskId = randomUUID()
    const token = randomUUID()

    await tasksRepo.insert({
      id: taskId,
      idempotencyKey: randomUUID(),
      type: 'test-executor',
      executorUrl: 'http://example.com',
      status: 'PROCESSING',
      callbackToken: token,
      processingStartedAt: new Date(),
    })
    await request(server)
      .patch(`/tasks/${taskId}/progress`)
      .set('Authorization', `Bearer ${token}`)
      .send({ progress: 50 })
      .expect(204)

    const updatedTask = await tasksRepo.findById(taskId)
    expect(updatedTask?.progress).toBe(50)
  })

  it('should reject callback with invalid token', async () => {
    const taskId = randomUUID()
    const token = randomUUID()

    await tasksRepo.insert({
      id: taskId,
      idempotencyKey: randomUUID(),
      type: 'test-executor-invalid',
      executorUrl: 'http://example.com',
      status: 'PROCESSING',
      callbackToken: token,
      processingStartedAt: new Date(),
    })
    await request(server)
      .post(`/tasks/${taskId}/result`)
      .set('Authorization', `Bearer wrong-token`)
      .send({ status: 'COMPLETED', result: { done: true } })
      .expect(401)
  })

  it('should accept result and mark task as completed', async () => {
    const taskId = randomUUID()
    const token = randomUUID()

    await tasksRepo.insert({
      id: taskId,
      idempotencyKey: randomUUID(),
      type: 'test-executor-result',
      executorUrl: 'http://example.com',
      status: 'PROCESSING',
      callbackToken: token,
      processingStartedAt: new Date(),
    })
    await request(server)
      .post(`/tasks/${taskId}/result`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed', result: { done: true } })
      .expect(204)

    const updatedTask = await tasksRepo.findById(taskId)
    expect(updatedTask?.status).toBe('COMPLETED')
    // Note: the result JSON stringifies based on Drizzle/Postgres mapping
    expect(updatedTask?.result).toEqual({ done: true })
  })

  it('should reject result if task is not in PROCESSING state', async () => {
    const taskId = randomUUID()
    const token = randomUUID()

    await tasksRepo.insert({
      id: taskId,
      idempotencyKey: randomUUID(),
      type: 'test-executor-conflict',
      executorUrl: 'http://example.com',
      status: 'COMPLETED',
      callbackToken: token,
      processingStartedAt: new Date(),
      completedAt: new Date(),
    })
    await request(server)
      .post(`/tasks/${taskId}/result`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed', result: { done: true } })
      .expect(409)
  })
})
