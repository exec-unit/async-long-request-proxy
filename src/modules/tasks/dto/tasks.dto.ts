import { z } from 'zod'
import { insertTaskSchema, selectTaskSchema } from '../schemas/tasks.sql.js'

export const CreateTaskSchema = insertTaskSchema
  .pick({
    type: true,
    payload: true,
    executorUrl: true,
    cancelUrl: true,
    idempotencyKey: true,
    webhookUrl: true,
    timeoutSeconds: true,
  })
  .extend({
    executorUrl: z.url(),
    cancelUrl: z.url().optional(),
    webhookUrl: z.url().optional(),
    timeoutSeconds: z.number().int().min(1).max(86400).optional().default(300),
  })

export type CreateTaskDto = z.infer<typeof CreateTaskSchema>

/** Response shape for task creation (202 Accepted). */
export const TaskCreatedResponseSchema = z.object({
  taskId: z.uuid(),
  statusUrl: z.url(),
  streamUrl: z.url(),
})

export type TaskCreatedResponseDto = z.infer<typeof TaskCreatedResponseSchema>

/** Inferred from Drizzle schema. `callbackToken` is omitted to prevent secret leakage. */
export const TaskResponseSchema = selectTaskSchema.omit({
  callbackToken: true,
})

export type TaskResponseDto = z.infer<typeof TaskResponseSchema>
