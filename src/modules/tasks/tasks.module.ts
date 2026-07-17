import { Module } from '@nestjs/common'
import { TasksController } from './tasks.controller.js'
import { TasksService } from './tasks.service.js'
import { TasksRepository } from './tasks.repository.js'

@Module({
  controllers: [TasksController],
  providers: [TasksService, TasksRepository],
  exports: [],
})
export class TasksModule {}
