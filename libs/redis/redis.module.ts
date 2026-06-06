import {
  Module,
  Global,
  type DynamicModule,
  type Provider,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common'
import { RedisService } from './redis.service.js'

export const REDIS_OPTIONS = Symbol('REDIS_OPTIONS')

/** Connection parameters for the Redis client. */
export interface RedisModuleOptions {
  host: string
  port: number
  password?: string
  db?: number
}

export interface RedisModuleAsyncOptions {
  inject?: Array<InjectionToken | OptionalFactoryDependency>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => Promise<RedisModuleOptions> | RedisModuleOptions
}

@Global()
@Module({})
export class RedisModule {
  static forRootAsync(options: RedisModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: REDIS_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    }

    return {
      module: RedisModule,
      providers: [
        optionsProvider,
        {
          provide: RedisService,
          useFactory: (opts: RedisModuleOptions) => new RedisService(opts),
          inject: [REDIS_OPTIONS],
        },
      ],
      exports: [RedisService],
    }
  }
}
