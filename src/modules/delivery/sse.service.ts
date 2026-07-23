import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Observable } from 'rxjs'
import type { MessageEvent } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { RedisService } from '#libs/redis/index.js'
import { TasksRepository } from '../tasks/tasks.repository.js'
import { EventsRepository } from './events.repository.js'
import type { TaskEventSelect, TaskEventType } from './schemas/events.sql.js'

const TERMINAL_EVENT_TYPES = new Set<TaskEventType>(['completed', 'failed', 'cancelled'])

/**
 * 25 s keeps the connection alive through reverse proxies (nginx proxy_read_timeout,
 * ALB idle timeout) that would otherwise silently drop quiet SSE connections.
 */
const HEARTBEAT_INTERVAL_MS = 25_000

const HEARTBEAT_EVENT: MessageEvent = { data: '', type: 'ping' }

/**
 * Maps a DB event row to the SSE wire format.
 * `seq` becomes Last-Event-ID so clients can resume after disconnect.
 * DB-internal fields (id, taskId, createdAt) are stripped from the payload.
 */
function toMessageEvent(event: TaskEventSelect): MessageEvent {
  const { id: _id, taskId: _taskId, seq, createdAt: _createdAt, ...eventPayload } = event
  return {
    id: String(seq),
    type: eventPayload.eventType,
    data: JSON.stringify(eventPayload),
  }
}

/**
 * Delivers task lifecycle events over SSE via event sourcing + Redis Pub/Sub.
 *
 * Each connection gets a dedicated ioredis subscriber client because ioredis
 * enters subscriber-only mode on `.subscribe()`, blocking all other commands
 * on that connection.
 */
@Injectable()
export class SseService {
  private readonly logger = new Logger(SseService.name)

  constructor(
    private readonly redis: RedisService,
    private readonly tasksRepo: TasksRepository,
    private readonly eventsRepo: EventsRepository,
  ) {}

  /**
   * Opens an SSE stream for a task. Replays history from `afterSeq`,
   * then streams live Pub/Sub events until a terminal state is reached.
   * Includes parallel heartbeat pings to prevent proxy idle timeouts.
   */
  async stream(taskId: string, afterSeq: number): Promise<Observable<MessageEvent>> {
    const task = await this.tasksRepo.findById(taskId)
    if (!task) throw new NotFoundException(`Task ${taskId} not found`)

    return new Observable<MessageEvent>((subscriber) => {
      let isDone = false
      let historyLoaded = false
      let highestHistorySeq = afterSeq
      const liveBuffer: TaskEventSelect[] = []

      // Dedicated subscriber client — isolated from the shared business connection.
      const subClient = (this.redis.client as Redis).duplicate()
      const channel = `task:${taskId}`

      void subClient.subscribe(channel, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to channel ${channel}: ${err.message}`)
          subscriber.error(err)
        }
      })

      subClient.on('message', (_chan: string, rawMessage: string) => {
        if (isDone) return
        try {
          const event = JSON.parse(rawMessage) as TaskEventSelect

          if (!historyLoaded) {
            liveBuffer.push(event)
            return
          }

          if (event.seq > highestHistorySeq) {
            highestHistorySeq = event.seq
            subscriber.next(toMessageEvent(event))
            if (TERMINAL_EVENT_TYPES.has(event.eventType)) {
              isDone = true
              subscriber.complete()
            }
          }
        } catch (err) {
          this.logger.error(
            `Failed to parse Pub/Sub message on ${channel}: ${String(err)}`,
          )
        }
      })

      subClient.on('error', (err: Error) => {
        this.logger.error(`Redis subscriber error on ${channel}: ${err.message}`)
        subscriber.error(err)
      })

      const heartbeatTimer = setInterval(() => {
        if (!isDone) subscriber.next(HEARTBEAT_EVENT)
      }, HEARTBEAT_INTERVAL_MS)

      // Fetch history AFTER subscribing to Redis to guarantee no missed events.
      this.eventsRepo
        .findEventsSince(taskId, afterSeq)
        .then((events) => {
          if (isDone) return

          for (const event of events) {
            highestHistorySeq = Math.max(highestHistorySeq, event.seq)
            subscriber.next(toMessageEvent(event))
            if (TERMINAL_EVENT_TYPES.has(event.eventType)) {
              isDone = true
              subscriber.complete()
              return
            }
          }

          historyLoaded = true
          for (const event of liveBuffer) {
            if (event.seq > highestHistorySeq) {
              highestHistorySeq = event.seq
              subscriber.next(toMessageEvent(event))
              if (TERMINAL_EVENT_TYPES.has(event.eventType)) {
                isDone = true
                subscriber.complete()
                return
              }
            }
          }
        })
        .catch((err: unknown) => {
          if (!isDone) subscriber.error(err)
        })

      return () => {
        isDone = true
        clearInterval(heartbeatTimer)
        subClient
          .unsubscribe(channel)
          .finally(() => {
            void subClient.quit()
          })
          .catch((err: unknown) => {
            this.logger.error(`Failed to unsubscribe SSE client: ${String(err)}`)
          })
        this.logger.debug(`SSE stream closed for taskId=${taskId}`)
      }
    })
  }
}
