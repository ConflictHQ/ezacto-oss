import type { ResourceCalendar, ResourceCalendarContext } from '@conflict-hq/ezacto-client'
import { addCalendarDays, type AllocationRow } from './model.js'

export type AllocationGesture = 'move' | 'start' | 'end'
export interface AllocationDates { readonly start_date: string; readonly end_date: string }
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000
export const validAllocationDates = (dates: AllocationDates) =>
  [dates.start_date, dates.end_date].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(dayNumber(date)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date && date >= '0100-01-01') && dates.start_date <= dates.end_date

/** Floating calendar dates: DST and device time zone cannot change gesture distance. */
export const gestureDates = (source: AllocationDates, action: AllocationGesture, days: number): AllocationDates => ({
  start_date: addCalendarDays(source.start_date, action === 'end' ? 0 : days),
  end_date: addCalendarDays(source.end_date, action === 'start' ? 0 : days),
})
const startOfWeek = (date: string, day: ResourceCalendarContext['week_start_day']) => {
  const first = { saturday: 6, sunday: 0, monday: 1 }[day]
  return addCalendarDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() - first + 7) % 7))
}
const touches = (dates: AllocationDates, week: string) => dates.start_date <= addCalendarDays(week, 6) && dates.end_date >= week

/** Include freed weeks too. Requests/pages stay bounded to the native 53-week limit. */
export const allocationReviewWeeks = (source: AllocationDates, next: AllocationDates, day: ResourceCalendarContext['week_start_day']): string[] => {
  if (!validAllocationDates(source) || !validAllocationDates(next)) throw new Error('Choose a valid ordered date range.')
  const weeks = new Set<string>()
  for (const dates of [source, next]) {
    const last = startOfWeek(dates.end_date, day)
    for (let week = startOfWeek(dates.start_date, day); week <= last; week = addCalendarDays(week, 7)) weeks.add(week)
  }
  return [...weeks].sort()
}
export interface AllocationWeekPreview {
  readonly week: string
  readonly allocationSeconds: number
  readonly personSeconds: number
  readonly availableSeconds: number
  readonly overAllocated: boolean
}
export const previewAllocationWeeks = (source: AllocationRow, next: AllocationDates, weeks: readonly string[], report: ResourceCalendar): AllocationWeekPreview[] => {
  const person = report.people.find(person => person.person_id === source.user_id)
  return weeks.map(week => {
    const current = person?.weeks.find(row => row.week_start === week)
    if (!current) throw new Error('Availability is incomplete. Refresh this preview before saving.')
    const allocationSeconds = touches(next, week) ? source.planned_seconds_per_week : 0
    const personSeconds = current.person_planned_seconds - (touches(source, week) ? source.planned_seconds_per_week : 0) + allocationSeconds
    if (personSeconds < 0) throw new Error('The allocation changed. Refresh this preview before saving.')
    return { week, allocationSeconds, personSeconds, availableSeconds: current.available_seconds, overAllocated: personSeconds > current.available_seconds }
  })
}

/** A page may skip a gap between old/new ranges; never make an oversized native request. */
export const allocationReviewPage = (weeks: readonly string[], offset: number): string[] => {
  const first = weeks[offset]
  return first ? weeks.slice(offset, offset + 53).filter(week => dayNumber(week) - dayNumber(first) <= 52 * 7) : []
}
