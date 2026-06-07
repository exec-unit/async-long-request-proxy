import { type DynamicModule, Module, type FactoryProvider } from '@nestjs/common'
import { BullMqAdapter, QUEUE_CONFIG } from './bullmq.adapter.js'
import { QUEUE_ADAPTER } from './queue-adapter.interface.js'
import type { QueueConfig } from './queue.types.js'

type AsyncOptions = Pick<FactoryProvider, 'useFactory' | 'inject'>

/**
 * Global queue infrastructure module.
 * Register once in AppModule via QueueModule.forRoot(config).
 * All feature modules import QueueModule to get IQueueAdapter injected.
 */
@Module({})
export class QueueModule {
  static forRoot(config: QueueConfig): DynamicModule {
    return QueueModule.build({ useFactory: () => config })
  }

  static forRootAsync(options: AsyncOptions): DynamicModule {
    return QueueModule.build(options)
  }

  private static build(options: AsyncOptions): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      providers: [
        {
          provide: QUEUE_CONFIG,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        BullMqAdapter,
        { provide: QUEUE_ADAPTER, useExisting: BullMqAdapter },
      ],
      exports: [QUEUE_ADAPTER],
    }
  }
}
