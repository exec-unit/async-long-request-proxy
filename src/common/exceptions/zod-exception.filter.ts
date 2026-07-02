import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import type { Request, Response } from 'express'

// ---------------------------------------------------------------------------
// Response shape types
// ---------------------------------------------------------------------------

interface ValidationIssue {
  field: string
  message: string
  code: string
  /** Present when the issue is an invalid_union - shows per-branch errors. */
  unionErrors?: ValidationIssue[][]
}

interface ErrorBody {
  statusCode: number
  error: string
  message: string
  path: string
  timestamp: string
  /** Present only for 400 Bad Request validation responses. */
  issues?: ValidationIssue[]
}

// ---------------------------------------------------------------------------
// Raw Zod issue shape (subset we actually use)
// ---------------------------------------------------------------------------

interface RawZodIssue {
  code: string
  path: (string | number)[]
  message: string
  errors?: RawZodIssue[][]
}

interface ZodErrorLike extends Error {
  issues: RawZodIssue[]
}

/**
 * Catches every unhandled exception across the entire application.
 * Normalises the response shape and logs 5xx errors as errors, 4xx as warnings.
 * ZodError is parsed into a structured `issues` array with nested union errors.
 * Local exception filters in individual controllers take precedence.
 */
@Catch()
export class ZodExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ZodExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const request = ctx.getRequest<Request>()
    const response = ctx.getResponse<Response>()

    const resolved = this.resolveException(exception)
    const body: ErrorBody = {
      statusCode: resolved.status,
      error: this.statusToText(resolved.status),
      message: resolved.message,
      path: request.url,
      timestamp: new Date().toISOString(),
      ...(resolved.issues !== undefined && { issues: resolved.issues }),
    }

    if (resolved.status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${String(resolved.status)}: ${resolved.message}`,
        exception instanceof Error ? exception.stack : String(exception),
      )
    } else {
      this.logger.warn(
        `${request.method} ${request.url} → ${String(resolved.status)}: ${resolved.message}`,
      )
    }

    response.status(resolved.status).json(body)
  }

  // ---------------------------------------------------------------------------

  private statusToText(status: number): string {
    const map: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
    }
    return map[status] ?? `HTTP ${String(status)}`
  }

  private resolveException(exception: unknown): {
    status: number
    message: string
    issues?: ValidationIssue[]
  } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse()
      const resObj = typeof res === 'object' ? (res as Record<string, unknown>) : null
      const message =
        resObj !== null && 'message' in resObj
          ? String(resObj['message'])
          : exception.message
      return { status: exception.getStatus(), message }
    }

    // ZodError thrown by @ParseBody / @ParseQuery decorators - invalid client input
    if (exception instanceof Error && exception.constructor.name === 'ZodError') {
      const zod = exception as ZodErrorLike
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Validation failed',
        issues: zod.issues.map((issue) => this.formatIssue(issue)),
      }
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' }
  }

  private formatIssue(issue: RawZodIssue): ValidationIssue {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    const base: ValidationIssue = { field, message: issue.message, code: issue.code }

    if (issue.code === 'invalid_union' && Array.isArray(issue.errors)) {
      const branches = issue.errors.map((branch) =>
        branch.map((i) => this.formatIssue(i)),
      )
      // Deduplicate across branches: identical field+code+message pairs collapse into one
      const seen = new Set<string>()
      base.unionErrors = branches
        .map((branch) =>
          branch.filter((i) => {
            const key = `${i.field}|${i.code}|${i.message}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          }),
        )
        .filter((branch) => branch.length > 0)
    }

    return base
  }
}
