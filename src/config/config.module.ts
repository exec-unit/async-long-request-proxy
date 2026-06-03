import { Global, Module, type DynamicModule } from '@nestjs/common'
import { APP_CONFIG } from './index.js'
import type { AppConfig } from './app.config.js'

/**
 * Registers APP_CONFIG as a global provider.
 * Import once in AppModule — all modules can then inject via @Inject(APP_CONFIG).
 */
@Global()
@Module({})
export class ConfigProviderModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigProviderModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    }
  }
}
