import type { NestMiddleware } from '@nestjs/common'
import { Injectable } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

/**
 * Propagates incoming `X-Request-ID` or generates a UUIDv4,
 * attaching it to both req/res for log correlation.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id']
    const requestId =
      typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID()

    // Expose on the request object for downstream access (e.g. logging interceptors).
    req.headers['x-request-id'] = requestId
    res.setHeader('X-Request-ID', requestId)

    next()
  }
}
