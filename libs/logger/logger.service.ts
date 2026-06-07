import { Injectable, type LoggerService } from '@nestjs/common'
import pino, { type Logger as PinoInstance } from 'pino'

/**
 * Pino-backed NestJS logger.
 * In production: JSON output to stdout (structured, for log aggregators).
 * In development: coloured single-line output via pino-pretty transport.
 */
@Injectable()
export class AppLogger implements LoggerService {
  private readonly logger: PinoInstance
  private readonly globalContext: string | undefined

  constructor(context?: string) {
    this.globalContext = context
    const isProd = process.env['NODE_ENV'] === 'production'

    this.logger = pino({
      level: isProd ? 'info' : 'debug',
      formatters: {
        level(label) {
          return { level: label }
        },
      },
      base: {
        service: 'async-long-request-proxy',
        env: process.env['NODE_ENV'],
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      ...(!isProd && {
        transport: {
          target: new URL('./pretty.transport.js', import.meta.url).href,
          options: {
            colorize: true,
            singleLine: true,
            levelFirst: true,
            ignore: 'context,service,env',
            translateTime: 'SYS:yyyy.mm.dd, HH:MM:ss',
            // NestJS-like: "INFO [Context] Message"
            messageFormat: '\x1B[33m[{context}]\x1B[37m {msg}\x1B[39m',
            customColors: 'info:cyan,debug:blue,warn:yellow,error:red,fatal:bgRed',
          },
        },
      }),
    })
  }

  // NestJS passes context as the last spread argument; fall back to the instance-level default.
  private resolveContext(params: unknown[]): string {
    const last = params[params.length - 1]
    return (typeof last === 'string' ? last : this.globalContext) ?? 'App'
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info({ context: this.resolveContext(optionalParams) }, String(message))
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    const context = this.resolveContext(optionalParams)
    // NestJS error() signature: error(msg, trace?, context?)
    const trace = optionalParams.length > 1 ? optionalParams[0] : undefined
    this.logger.error({ context, trace }, String(message))
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn({ context: this.resolveContext(optionalParams) }, String(message))
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug({ context: this.resolveContext(optionalParams) }, String(message))
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.trace({ context: this.resolveContext(optionalParams) }, String(message))
  }
}
