import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  InternalServerErrorException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import type { Request } from 'express'
import { TasksService } from './tasks.service.js'
import { ParseBody, ApiZodResponse } from '#src/common/index.js'
import {
  CreateTaskSchema,
  TaskCreatedResponseSchema,
  TaskResponseSchema,
} from './dto/tasks.dto.js'
import type {
  CreateTaskDto,
  TaskCreatedResponseDto,
  TaskResponseDto,
} from './dto/tasks.dto.js'

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  /** Accepts a new long-running task and queues it for async execution (idempotent). */
  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  @ApiZodResponse(
    HttpStatus.ACCEPTED,
    TaskCreatedResponseSchema,
    'Task accepted for processing',
  )
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @ParseBody(CreateTaskSchema) dto: CreateTaskDto,
    @Req() req: Request,
  ): Promise<TaskCreatedResponseDto> {
    // Build the baseUrl from the incoming request so the service stays
    // decoupled from any hardcoded hostname or port config.
    const host = req.get('host')
    if (!host) {
      throw new InternalServerErrorException(
        'Host header is missing - check reverse proxy config',
      )
    }

    const baseUrl = `${req.protocol}://${host}`
    return this.tasksService.create(dto, baseUrl)
  }

  /** Returns the current task snapshot including status, result, and progress. */
  @Get(':id')
  @ApiOperation({ summary: 'Get task status' })
  @ApiZodResponse(HttpStatus.OK, TaskResponseSchema, 'Returns the task snapshot')
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Task not found' })
  async getStatus(@Param('id', ParseUUIDPipe) id: string): Promise<TaskResponseDto> {
    const task = await this.tasksService.getStatus(id)
    // Never expose the callbackToken to clients
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { callbackToken, ...publicTask } = task
    return publicTask
  }

  /** Cancels a PENDING task. Returns 409 if already processing or finished. */
  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a pending task' })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Task cancelled successfully',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Task is already processing or finished',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.tasksService.cancel(id)
  }
}
