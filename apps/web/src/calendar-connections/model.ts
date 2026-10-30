import type { CalendarConnectionList, CalendarRefreshResult } from '@conflict-hq/ezacto-client'

export type CalendarConnection = CalendarConnectionList['data'][number]
export type CalendarProvider = CalendarConnection['provider']
export interface CalendarConnectionApi {
  manualCleanup?(signal: AbortSignal): Promise<CalendarManualCleanup[]>
  confirmManualCleanup?(item: CalendarManualCleanup, signal: AbortSignal): Promise<void>
  list(signal: AbortSignal): Promise<CalendarConnectionList>
  authorize(provider: CalendarProvider, generation: number, signal: AbortSignal): Promise<string>
  refresh(provider: CalendarProvider, signal: AbortSignal): Promise<CalendarRefreshResult>
  disconnect(provider: CalendarProvider, generation: number, signal: AbortSignal): Promise<void>
}

export interface CalendarManualCleanup {
  id: string
  generation: number
  credential_revision: number
  reason: 'disconnect' | 'reauth'
  created_at: string
}
