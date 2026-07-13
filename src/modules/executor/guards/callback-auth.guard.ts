import {
  type CanActivate,
  ConflictException,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import { TasksRepository } from '../../tasks/tasks.repository.js'
import type { TaskSelect } from '../../tasks/schemas/tasks.sql.js'

export interface AuthenticatedRequest extends Request {
  task: TaskSelect
}

/**
 * Guards executor callback endpoints (POST /result, PATCH /progress).
 * Validates the Bearer token against the task's callback_token column using a
 * constant-time comparison to prevent timing-based token enumeration attacks.
 */
@Injectable()
export class CallbackAuthGuard implements CanActivate {
  constructor(private readonly tasksRepo: TasksRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>()

    const token = this.extractBearerToken(req)
    if (!token) throw new UnauthorizedException('Bearer token is required')

    const taskId = req.params['id'] as string | undefined
    if (!taskId) throw new NotFoundException('Task not found')

    const task = await this.tasksRepo.findById(taskId)
    if (!task) throw new NotFoundException('Task not found')

    this.validateToken(token, task.callbackToken, taskId)

    if (task.status !== 'PROCESSING') {
      throw new ConflictException(
        `Task ${taskId} is not in PROCESSING state (current: ${task.status})`,
      )
    }

    // Attach full task to request to avoid a redundant DB round-trip in the controller
    req.task = task
    return true
  }

  private extractBearerToken(req: Request): string | undefined {
    const auth = req.headers['authorization']
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return undefined
    const token = auth.slice(7).trim()
    return token.length > 0 ? token : undefined
  }

  private validateToken(
    provided: string,
    stored: string | null | undefined,
    taskId: string,
  ): void {
    if (!stored) {
      throw new UnauthorizedException(`Task ${taskId} has no callback token configured`)
    }

    const providedBuf = Buffer.from(provided)
    const storedBuf = Buffer.from(stored)

    const maxLen = Math.max(providedBuf.length, storedBuf.length)
    const a = Buffer.alloc(maxLen)
    const b = Buffer.alloc(maxLen)
    providedBuf.copy(a)
    storedBuf.copy(b)

    const match = timingSafeEqual(a, b) && providedBuf.length === storedBuf.length

    if (!match) throw new UnauthorizedException('Invalid callback token')
  }
}
