import { Global, Module } from '@nestjs/common'
import { DrizzleProvider, DrizzleService, DB_CONNECTION } from './drizzle.provider.js'

/** Provides DB_CONNECTION globally — import once in AppModule. */
@Global()
@Module({
  providers: [DrizzleService, DrizzleProvider],
  exports: [DB_CONNECTION, DrizzleService],
})
export class DrizzleModule {}
