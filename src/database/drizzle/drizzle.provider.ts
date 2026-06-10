import { Inject, type Provider } from '@nestjs/common'
import { DrizzleService } from './drizzle.service.js'
import type { DrizzleDb } from './drizzle.service.js'
import { APP_CONFIG } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'

export { DrizzleService } from './drizzle.service.js'
export type { DrizzleDb } from './drizzle.service.js'

export const DB_CONNECTION = Symbol('DB_CONNECTION')

/** Convenience decorator — replaces @Inject(DB_CONNECTION) in service constructors. */
export const InjectDb = (): ParameterDecorator => Inject(DB_CONNECTION)

export const DrizzleProvider: Provider = {
  provide: DB_CONNECTION,
  inject: [DrizzleService, APP_CONFIG],
  useFactory: async (service: DrizzleService, config: AppConfig): Promise<DrizzleDb> => {
    await service.connect(config)
    return service.db
  },
}
