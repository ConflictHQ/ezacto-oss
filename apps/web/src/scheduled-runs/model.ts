import type { ScheduledRun } from '@ezacto/core'
export interface ScheduledRunApi {
  consumeReviewLink?(id:number,token:string,signal?:AbortSignal):Promise<void>
  read(id: number, signal?: AbortSignal): Promise<{ data: ScheduledRun }>
  confirm(
    id: number,
    signal?: AbortSignal,
    acknowledgeReportWarnings?: boolean,
  ): Promise<{ data: ScheduledRun }>
  retry?(id: number, signal?: AbortSignal): Promise<{ data: ScheduledRun }>
  cancel(id: number, signal?: AbortSignal): Promise<{ data: ScheduledRun }>
}
