import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger'
import { CallbackAuthGuard } from './guards/callback-auth.guard.js'
import type { AuthenticatedRequest } from './guards/callback-auth.guard.js'
import { ExecutorService } from './executor.service.js'
import { ParseBody } from '#src/common/index.js'
import { SubmitResultSchema, UpdateProgressSchema } from './dto/executor.dto.js'
import type { SubmitResultDto, UpdateProgressDto } from './dto/executor.dto.js'

/**
 * Internal callback contract for executor services.
 * All endpoints require a valid Bearer callback token issued at task creation.
 */
@ApiTags('executor')
@ApiBearerAuth()
@UseGuards(CallbackAuthGuard)
@Controller('tasks/:id')
export class ExecutorController {
  constructor(private readonly executorService: ExecutorService) {}

  /** Called by the executor when the task completes or fails. Transitions PROCESSING → COMPLETED|FAILED. */
  @Post('result')
  @ApiOperation({ summary: 'Submit task result or failure from executor' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Result accepted' })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid or missing callback token',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Task is not in PROCESSING state',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async submitResult(
    @Param('id', ParseUUIDPipe) _id: string,
    @ParseBody(SubmitResultSchema) dto: SubmitResultDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    return this.executorService.submitResult(req.task, dto)
  }

  /** Allows the executor to report incremental progress (0–100). */
  @Patch('progress')
  @ApiOperation({ summary: 'Update task progress from executor' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Progress updated' })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid or missing callback token',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Task is not in PROCESSING state',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateProgress(
    @Param('id', ParseUUIDPipe) _id: string,
    @ParseBody(UpdateProgressSchema) dto: UpdateProgressDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    return this.executorService.updateProgress(req.task, dto)
  }
}
