import { Inject } from '@nestjs/common'

export { appConfig } from './app.config.js'
export { ConfigProviderModule } from './config.module.js'
export type { AppConfig } from './app.config.js'
export type { Env } from './env.schema.js'

/** DI token for injecting the validated AppConfig object directly. */
export const APP_CONFIG = Symbol('APP_CONFIG')

/** Convenience decorator — replaces @Inject(APP_CONFIG) in service/strategy constructors. */
export const InjectConfig = (): ParameterDecorator => Inject(APP_CONFIG)
