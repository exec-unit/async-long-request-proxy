/**
 * Thrown when a server-side or network error persists after all retry attempts.
 * The caller should treat the destination as unavailable and update task state accordingly.
 */
export class DispatchFailedError extends Error {
  readonly attempts: number
  readonly lastStatusCode: number | undefined

  constructor(url: string, attempts: number, cause: unknown, lastStatusCode?: number) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`POST ${url} failed after ${String(attempts)} attempt(s): ${reason}`)
    this.name = 'DispatchFailedError'
    this.attempts = attempts
    this.lastStatusCode = lastStatusCode
    // Preserves the original error for structured logging
    this.cause = cause
  }
}

/**
 * Thrown immediately (no retry) when the destination returns a 4xx response
 * (except 429). A client-side error won't resolve itself with retries.
 */
export class NonRetryableError extends Error {
  readonly statusCode: number

  constructor(url: string, statusCode: number) {
    super(`POST ${url} rejected with ${String(statusCode)} - not retrying`)
    this.name = 'NonRetryableError'
    this.statusCode = statusCode
  }
}
