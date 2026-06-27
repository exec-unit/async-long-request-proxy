import { Injectable, Logger } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
import { firstValueFrom, timeout } from 'rxjs'
import { DispatchFailedError, NonRetryableError } from './errors.js'

export interface HttpRetryOptions {
  /** Total attempts including the first try. Default: 3 */
  attempts?: number
  /** Base delay in ms for exponential backoff. Default: 500 */
  baseDelayMs?: number
  /** Maximum delay cap in ms. Default: 30_000 */
  maxDelayMs?: number
  /** Per-request timeout in ms. Default: 10_000 */
  requestTimeoutMs?: number
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

/** Set of Node.js error codes that indicate a transient network failure. */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNABORTED',
  'ERR_NETWORK',
])

function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof Error && 'code' in err) {
    return RETRYABLE_NETWORK_CODES.has((err as NodeJS.ErrnoException).code ?? '')
  }
  return false
}

function jitter(): number {
  return Math.floor(Math.random() * 200)
}

function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempt + jitter(), maxDelayMs)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * HTTP POST client with exponential backoff.
 * Retries on 5xx, 429, and network errors.
 * Fails fast on 4xx (except 429) - no retry can fix a client-side error.
 */
@Injectable()
export class HttpRetryService {
  private readonly logger = new Logger(HttpRetryService.name)

  constructor(private readonly httpService: HttpService) {}

  async post<T = unknown>(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
    opts: HttpRetryOptions = {},
  ): Promise<T> {
    const {
      attempts = 3,
      baseDelayMs = 500,
      maxDelayMs = 30_000,
      requestTimeoutMs = 10_000,
    } = opts

    let lastError: unknown
    let lastStatusCode: number | undefined

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await firstValueFrom(
          this.httpService
            .post<T>(url, body, { headers })
            .pipe(timeout(requestTimeoutMs)),
        )
        return response.data
      } catch (err: unknown) {
        lastError = err

        const statusCode = getStatusCode(err)

        if (statusCode !== undefined) {
          lastStatusCode = statusCode

          if (!RETRYABLE_STATUS_CODES.has(statusCode)) {
            // 4xx (except 429) is a client error - retrying won't change the outcome.
            throw new NonRetryableError(url, statusCode)
          }
        } else if (!isRetryableNetworkError(err)) {
          // Not an HTTP error and not a known transient network code - don't retry.
          throw new DispatchFailedError(url, attempt + 1, err)
        }

        const isLastAttempt = attempt === attempts - 1
        if (isLastAttempt) break

        const delay = computeDelay(attempt, baseDelayMs, maxDelayMs)
        this.logger.warn(
          `HTTP attempt ${String(attempt + 1)}/${String(attempts)} to ${url} failed (status=${statusCode !== undefined ? String(statusCode) : 'network'}), retrying in ${String(delay)}ms`,
        )
        await sleep(delay)
      }
    }

    throw new DispatchFailedError(url, attempts, lastError, lastStatusCode)
  }
}

function getStatusCode(err: unknown): number | undefined {
  if (
    err != null &&
    typeof err === 'object' &&
    'response' in err &&
    err.response != null &&
    typeof err.response === 'object' &&
    'status' in err.response &&
    typeof err.response.status === 'number'
  ) {
    return err.response.status
  }
  return undefined
}
