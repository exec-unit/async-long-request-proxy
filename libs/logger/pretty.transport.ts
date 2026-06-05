import pretty from 'pino-pretty'

/**
 * Custom pino-pretty transport.
 * Wraps the formatted time string in green ANSI codes so it visually
 * matches the NestJS default log format in development.
 */
export default (opts: Parameters<typeof pretty>[0]) =>
  pretty({
    ...opts,
    customPrettifiers: {
      time: (value) =>
        `\x1B[32m[${typeof value === 'string' ? value : JSON.stringify(value)}]\x1B[39m`,
    },
  })
