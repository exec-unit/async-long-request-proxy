import { Test, TestingModule } from '@nestjs/testing'
import { HttpService } from '@nestjs/axios'
import { HttpRetryService } from './http-retry.service.js'
import { NonRetryableError, DispatchFailedError } from './errors.js'
import { of, throwError } from 'rxjs'
import type { AxiosResponse } from 'axios'

describe('HttpRetryService', () => {
  let service: HttpRetryService
  let httpService: jest.Mocked<HttpService>

  beforeEach(async () => {
    httpService = {
      post: jest.fn(),
    } as unknown as jest.Mocked<HttpService>

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpRetryService,
        {
          provide: HttpService,
          useValue: httpService,
        },
      ],
    }).compile()

    service = module.get<HttpRetryService>(HttpRetryService)
  })

  it('should return data successfully on first try', async () => {
    const mockResponse = { data: { success: true } } as AxiosResponse
    ;(httpService.post as jest.Mock).mockReturnValue(of(mockResponse))

    const result = await service.post('http://example.com', {})
    expect(result).toEqual({ success: true })
    expect((httpService.post as jest.Mock).mock.calls.length).toBe(1)
  })

  it('should not retry on 400 Bad Request', async () => {
    const error = { response: { status: 400 } }
    ;(httpService.post as jest.Mock).mockReturnValue(throwError(() => error))

    await expect(
      service.post('http://example.com', {}, {}, { attempts: 3 }),
    ).rejects.toThrow(NonRetryableError)
    expect((httpService.post as jest.Mock).mock.calls.length).toBe(1)
  })

  it('should retry on 503 and eventually fail if all attempts exhausted', async () => {
    const error = { response: { status: 503 } }
    ;(httpService.post as jest.Mock).mockReturnValue(throwError(() => error))

    // Use small delays for tests
    await expect(
      service.post('http://example.com', {}, {}, { attempts: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(DispatchFailedError)

    expect((httpService.post as jest.Mock).mock.calls.length).toBe(2)
  })

  it('should retry on network error (ECONNRESET) and succeed', async () => {
    const networkError = Object.assign(new Error('Network error'), { code: 'ECONNRESET' })
    const successResponse = { data: { success: true } } as AxiosResponse

    ;(httpService.post as jest.Mock)
      .mockReturnValueOnce(throwError(() => networkError))
      .mockReturnValueOnce(of(successResponse))

    const result = await service.post('http://example.com', {}, {}, { baseDelayMs: 1 })

    expect(result).toEqual({ success: true })
    expect((httpService.post as jest.Mock).mock.calls.length).toBe(2)
  })
})
