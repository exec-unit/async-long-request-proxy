import {
  Controller,
  Get,
  Header,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Sse,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger'
import type { MessageEvent } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { SseService } from './sse.service.js'

/**
 * Parses the `Last-Event-ID` header into a non-negative integer sequence number.
 * Falls back to 0 (replay all) on missing or malformed values — this is
 * intentionally forgiving: a wrong seq causes extra data, not data loss.
 */
function parseLastEventId(raw: string | undefined): number {
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

/**
 * Exposes the Server-Sent Events endpoint for real-time task lifecycle notifications.
 * Uses event sourcing: clients reconnecting with `Last-Event-ID` receive all missed events.
 */
@ApiTags('tasks')
@Controller('tasks')
export class StreamController {
  constructor(private readonly sseService: SseService) {}

  /**
   * Opens a persistent SSE connection. Replays missed events from `Last-Event-ID`,
   * then delivers live updates until the task reaches a terminal state.
   */
  @Get(':id/stream')
  @Sse()
  // Prevent reverse proxies and CDNs from buffering the SSE response.
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache')
  @ApiOperation({ summary: 'Open SSE stream for real-time task events' })
  @ApiHeader({
    name: 'Last-Event-ID',
    description: 'Resume replay from this event sequence number (inclusive)',
    required: false,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'SSE stream opened; events follow task lifecycle',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Task not found',
  })
  async stream(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
  ): Promise<Observable<MessageEvent>> {
    const afterSeq = parseLastEventId(lastEventId)
    return this.sseService.stream(id, afterSeq)
  }
}
