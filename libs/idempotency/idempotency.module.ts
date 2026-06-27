import { Global, Module } from '@nestjs/common'
import { IdempotencyService } from './idempotency.service.js'

/** Global - import once in AppModule; all feature modules can inject IdempotencyService. */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
