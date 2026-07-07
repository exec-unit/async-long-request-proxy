// ---------------------------------------------------------------------------
// Input type - `seq` is auto-assigned; callers only provide the semantic fields.
// ---------------------------------------------------------------------------

export type ProgressEventInput = {
  taskId: string
  eventType: 'progress'
  progress: number
}
export type CompletedEventInput = {
  taskId: string
  eventType: 'completed'
  data: Record<string, unknown>
}
export type FailedEventInput = {
  taskId: string
  eventType: 'failed'
  error: { code: string; message: string; details?: unknown }
}
export type CancelledEventInput = { taskId: string; eventType: 'cancelled' }

export type InsertEventInput =
  ProgressEventInput | CompletedEventInput | FailedEventInput | CancelledEventInput
