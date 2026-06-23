import { Global, Module } from '@nestjs/common'
import { HttpModule } from '@nestjs/axios'
import { HttpRetryService } from './http-retry.service.js'

export { HttpRetryService } from './http-retry.service.js'
export { DispatchFailedError, NonRetryableError } from './errors.js'

@Global()
@Module({
  imports: [HttpModule],
  providers: [HttpRetryService],
  exports: [HttpRetryService],
})
export class HttpRetryModule {}
