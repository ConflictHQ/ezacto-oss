import type { CalendarFeedsApi } from './calendar-feeds-browser.js'
import type { ResourceCalendar, ResourceCalendarContext } from '@conflict-hq/ezacto-client'
import { addCalendarDays, type AllocationRow } from './model.js'

export interface CalendarQuery {
  readonly view: 'team' | 'project'
  readonly from: string
  readonly to: string
  readonly project_id?: number
  readonly person_id?: number
}
export interface CalendarPage<T> {
  readonly data: T
  readonly page: { readonly next_cursor: string | null }
}
export interface CalendarAllocation extends AllocationRow { readonly project_name: string }
export interface CalendarProject { readonly id: number; readonly name: string; readonly is_active: boolean }
export interface ResourceCalendarApi {
  feeds?: CalendarFeedsApi
  context(signal: AbortSignal): Promise<{ readonly data: ResourceCalendarContext }>
  read(query: CalendarQuery, cursor: string | undefined, signal: AbortSignal): Promise<CalendarPage<ResourceCalendar>>
  allocations(query: CalendarQuery, cursor: string | undefined, signal: AbortSignal): Promise<CalendarPage<readonly CalendarAllocation[]>>
  projects(cursor: string | undefined, signal: AbortSignal): Promise<CalendarPage<readonly CalendarProject[]>>
}

/** Read only bounded native pages. A repeated cursor is an error, never an endless loop. */
export const calendarPages = async <T>(
  read: (cursor?: string) => Promise<CalendarPage<readonly T[]>>,
  signal: AbortSignal,
): Promise<T[]> => {
  const rows: T[] = [], seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted()
    const response = await read(cursor)
    signal.throwIfAborted()
    rows.push(...response.data)
    const next = response.page.next_cursor
    if (next === null) return rows
    if (seen.has(next)) throw new Error('The calendar returned a repeated page. Retry loading.')
    seen.add(next)
    cursor = next
  }
  throw new Error('This calendar is too large to display. Narrow its scope.')
}

export const calendarWindow = (context: ResourceCalendarContext, offset: number) => {
  const from = addCalendarDays(context.current_week_start, offset * 56)
  return { from, to: addCalendarDays(from, 55) }
}

/** Real allocation endpoints determine each bar; weekly totals never invent dates. */
export const timelinePosition = (from: string, to: string, start: string, end: string) => {
  if (end < from || start > to) return null
  const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000
  const days = day(to) - day(from) + 1
  return {
    start: (Math.max(day(start), day(from)) - day(from)) / days * 100,
    width: (Math.min(day(end), day(to)) - Math.max(day(start), day(from)) + 1) / days * 100,
  }
}
