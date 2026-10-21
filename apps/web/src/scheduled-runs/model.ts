import type { ScheduledRun } from '@ezacto/core'
export interface ScheduledRunApi {
  read(id: number, signal?: AbortSignal): Promise<{ data: ScheduledRun }>
  confirm(id: number, signal?: AbortSignal): Promise<{ data: ScheduledRun }>
  cancel(id: number, signal?: AbortSignal): Promise<{ data: ScheduledRun }>
}
