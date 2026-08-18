import { Test, type TestingModule } from '@nestjs/testing'
import { WebhookProcessor } from './webhook.processor.js'
import { TasksRepository } from '../../tasks/tasks.repository.js'
import {
  HttpRetryService,
  DispatchFailedError,
  NonRetryableError,
} from '#libs/http-retry/index.js'
import { QUEUE_CONFIG } from '#libs/queue/index.js'

// Prevent BullMQ Worker from attempting a real Redis connection during unit tests.
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}))

/** Calls the private process() method without exposing it in production types. */
function invokeProcess(processor: WebhookProcessor, taskId: string): Promise<void> {
  return (
    processor as unknown as { process(data: { taskId: string }): Promise<void> }
  ).process({
    taskId,
  })
}

describe('WebhookProcessor', () => {
  let processor: WebhookProcessor
  let tasksRepo: { findById: jest.Mock }
  let httpRetry: { post: jest.Mock }

  beforeEach(async () => {
    tasksRepo = { findById: jest.fn() }
    httpRetry = { post: jest.fn() }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookProcessor,
        { provide: TasksRepository, useValue: tasksRepo },
        { provide: HttpRetryService, useValue: httpRetry },
        {
          provide: QUEUE_CONFIG,
          useValue: { clusterMode: false, host: 'localhost', port: 6379 },
        },
      ],
    }).compile()

    processor = module.get(WebhookProcessor)
    // Trigger BullMQ worker registration (mocked - no real Redis connection)
    processor.onModuleInit()
  })

  afterEach(async () => {
    await processor.onModuleDestroy()
  })

  it('should skip silently if task was deleted before delivery (e.g. retention sweep)', async () => {
    tasksRepo.findById.mockResolvedValue(null)

    await invokeProcess(processor, 'task-1')

    expect(httpRetry.post).not.toHaveBeenCalled()
  })

  it('should skip silently if task has no webhookUrl configured', async () => {
    tasksRepo.findById.mockResolvedValue({ id: 'task-1', webhookUrl: null })

    await invokeProcess(processor, 'task-1')

    expect(httpRetry.post).not.toHaveBeenCalled()
  })

  it('should deliver webhook with full payload on success', async () => {
    const webhookUrl = 'https://hooks.example.com/callback'
    tasksRepo.findById.mockResolvedValue({
      id: 'task-1',
      status: 'COMPLETED',
      webhookUrl,
      result: { answer: 42 },
      error: null,
    })
    httpRetry.post.mockResolvedValue(undefined)

    await invokeProcess(processor, 'task-1')

    expect(httpRetry.post).toHaveBeenCalledWith(
      webhookUrl,
      { taskId: 'task-1', status: 'COMPLETED', result: { answer: 42 } },
      {},
      { attempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 },
    )
  })

  it('should include error field in payload for FAILED tasks', async () => {
    const webhookUrl = 'https://hooks.example.com/callback'
    const taskError = { code: 'TIMEOUT', message: 'Task timed out' }
    tasksRepo.findById.mockResolvedValue({
      id: 'task-1',
      status: 'FAILED',
      webhookUrl,
      result: null,
      error: taskError,
    })
    httpRetry.post.mockResolvedValue(undefined)

    await invokeProcess(processor, 'task-1')

    expect(httpRetry.post).toHaveBeenCalledWith(
      webhookUrl,
      { taskId: 'task-1', status: 'FAILED', error: taskError },
      {},
      expect.any(Object),
    )
  })

  it('should swallow NonRetryableError - 4xx is client misconfiguration, retrying is pointless', async () => {
    tasksRepo.findById.mockResolvedValue({
      id: 'task-1',
      status: 'COMPLETED',
      webhookUrl: 'https://hooks.example.com/gone',
      result: null,
      error: null,
    })
    httpRetry.post.mockRejectedValue(
      new NonRetryableError('https://hooks.example.com/gone', 404),
    )

    // Task is already in a terminal state - webhook delivery is best-effort.
    await expect(invokeProcess(processor, 'task-1')).resolves.toBeUndefined()
  })

  it('should swallow DispatchFailedError - all retries exhausted, log and move on', async () => {
    tasksRepo.findById.mockResolvedValue({
      id: 'task-1',
      status: 'COMPLETED',
      webhookUrl: 'https://hooks.example.com/down',
      result: null,
      error: null,
    })
    httpRetry.post.mockRejectedValue(
      new DispatchFailedError(
        'https://hooks.example.com/down',
        5,
        new Error('connection refused'),
      ),
    )

    await expect(invokeProcess(processor, 'task-1')).resolves.toBeUndefined()
  })

  it('should re-throw unexpected errors to trigger BullMQ job retry', async () => {
    tasksRepo.findById.mockResolvedValue({
      id: 'task-1',
      status: 'COMPLETED',
      webhookUrl: 'https://hooks.example.com/callback',
      result: null,
      error: null,
    })
    // Any error that is not NonRetryableError or DispatchFailedError must propagate
    // so BullMQ retries the job according to its backoff config.
    httpRetry.post.mockRejectedValue(new Error('EPIPE: broken pipe'))

    await expect(invokeProcess(processor, 'task-1')).rejects.toThrow('EPIPE: broken pipe')
  })
})
