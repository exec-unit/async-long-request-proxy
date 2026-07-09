import { z } from 'zod'

const TaskErrorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1),
  details: z.unknown().optional(),
})

export const SubmitResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    result: z.record(z.string(), z.unknown()),
  }),
  z.object({
    status: z.literal('failed'),
    error: TaskErrorSchema,
  }),
])

export type SubmitResultDto = z.infer<typeof SubmitResultSchema>

export const UpdateProgressSchema = z.object({
  progress: z.int().min(0).max(100),
})

export type UpdateProgressDto = z.infer<typeof UpdateProgressSchema>
