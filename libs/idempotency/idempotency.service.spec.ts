import { Test, TestingModule } from '@nestjs/testing'
import { IdempotencyService } from './idempotency.service.js'
import { RedisService } from '#libs/redis/index.js'

describe('IdempotencyService', () => {
  let service: IdempotencyService
  let redisClientMock: { eval: jest.Mock; set: jest.Mock }
  let redisServiceMock: {
    client: { eval: jest.Mock; set: jest.Mock }
    get: jest.Mock
    del: jest.Mock
  }

  beforeEach(async () => {
    redisClientMock = {
      eval: jest.fn(),
      set: jest.fn(),
    }

    redisServiceMock = {
      client: redisClientMock,
      get: jest.fn(),
      del: jest.fn(),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        {
          provide: RedisService,
          useValue: redisServiceMock,
        },
      ],
    }).compile()

    service = module.get<IdempotencyService>(IdempotencyService)
  })

  it('should return acquired when Lua returns [1, nil]', async () => {
    redisClientMock.eval.mockResolvedValue([1, null])

    const result = await service.occupySlot('test-key', 60)
    expect(result).toEqual({ status: 'acquired' })
    expect(redisClientMock.eval).toHaveBeenCalledWith(
      expect.stringContaining('SET'),
      1,
      'idempotency:test-key',
      '__PENDING__',
      '60',
    )
  })

  it('should return pending if Lua returns [0, __PENDING__]', async () => {
    redisClientMock.eval.mockResolvedValue([0, '__PENDING__'])

    const result = await service.occupySlot('test-key', 60)
    expect(result).toEqual({ status: 'pending' })
  })

  it('should return pending if Lua returns [0, null] (key expired between SET NX and GET inside Lua)', async () => {
    redisClientMock.eval.mockResolvedValue([0, null])

    const result = await service.occupySlot('test-key', 60)
    expect(result).toEqual({ status: 'pending' })
  })

  it('should return duplicate with taskId if Lua returns [0, taskId]', async () => {
    redisClientMock.eval.mockResolvedValue([0, 'task-123'])

    const result = await service.occupySlot('test-key', 60)
    expect(result).toEqual({ status: 'duplicate', taskId: 'task-123' })
  })

  it('should commit result using KEEPTTL', async () => {
    redisClientMock.set.mockResolvedValue('OK')
    await service.commitResult('test-key', 'task-123')

    expect(redisClientMock.set).toHaveBeenCalledWith(
      'idempotency:test-key',
      'task-123',
      'KEEPTTL',
    )
  })

  it('should release slot by calling DEL', async () => {
    redisServiceMock.del.mockResolvedValue(1)
    await service.releaseSlot('test-key')

    expect(redisServiceMock.del).toHaveBeenCalledWith('idempotency:test-key')
  })
})
