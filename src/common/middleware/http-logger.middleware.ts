import { AppLogger } from '#libs/logger/logger.service.js'
import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

// ANSI color codes for status ranges, used only in dev
const STATUS_COLORS: Record<string, string> = {
  '2': '\x1B[32m',
  '3': '\x1B[36m',
  '4': '\x1B[33m',
  '5': '\x1B[31m',
}
const ANSI_RESET = '\x1B[39m'

@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private readonly logger = new AppLogger('HTTP')
  private readonly isDev = process.env['NODE_ENV'] !== 'production'

  private formatStatus(statusCode: number): string {
    const raw = statusCode.toString()
    if (!this.isDev) return raw
    const color = STATUS_COLORS[raw[0] ?? ''] ?? ''
    return `${color}${raw}${color ? ANSI_RESET : ''}`
  }

  private writeLog(statusCode: number, message: string): void {
    if (statusCode >= 500) {
      this.logger.error(message)
    } else if (statusCode >= 400) {
      this.logger.warn(message)
    } else {
      this.logger.log(message)
    }
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const { method, originalUrl } = req
    const startTime = Date.now()

    // Guard against double-logging when both finish and close fire
    let isLogged = false

    const logRequest = (event: 'finish' | 'aborted'): void => {
      if (isLogged) return
      isLogged = true

      const duration = Date.now() - startTime
      const { statusCode } = res
      const status = this.formatStatus(statusCode)

      const message =
        event === 'aborted'
          ? `${method} ${originalUrl} ABORTED - ${duration.toString()}ms`
          : `${method} ${originalUrl} ${status} - ${duration.toString()}ms`

      if (event === 'aborted') {
        this.logger.warn(message)
      } else {
        this.writeLog(statusCode, message)
      }
    }

    // finish: response fully sent (success or error handled by NestJS)
    res.on('finish', () => {
      logRequest('finish')
    })

    // close: socket destroyed before response completed (client abort / timeout)
    res.on('close', () => {
      if (!res.writableEnded) {
        logRequest('aborted')
      }
    })

    next()
  }
}
