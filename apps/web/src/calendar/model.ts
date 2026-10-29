/**
 * Laying a month of time entries out as a calendar: the ezacto-ui Month view,
 * a grid of weeks with each day's entries listed in its cell.
 *
 * A month on a calendar is drawn in whole weeks, so the grid runs from the
 * first day of the week that holds the 1st to the last day of the week that
 * holds the month's end, and the days outside the month are drawn greyed.
 * Which day starts a week is an organization setting (see `weekDates`), not
 * this module's to guess, so the caller supplies it.
 */

import { weekDates } from '../week-grid/model.js'

export type WeekStartDay = 'saturday' | 'sunday' | 'monday'

export interface CalendarEntry {
  readonly id: number
  readonly spent_date: string
  readonly seconds: number
  readonly project_id: number
  readonly task_id: number
  readonly notes?: string | null
  readonly is_running?: boolean
}

export interface CalendarCell<E extends CalendarEntry = CalendarEntry> {
  readonly date: string
  /** False for the days that fill out the first and last weeks. */
  readonly inMonth: boolean
  readonly entries: readonly E[]
  readonly totalSeconds: number
}

export interface CalendarMonth<E extends CalendarEntry = CalendarEntry> {
  /** The 1st of the month, as a calendar date. */
  readonly monthStart: string
  /** The grid's first and last days: whole weeks around the month. */
  readonly from: string
  readonly to: string
  readonly weeks: readonly (readonly CalendarCell<E>[])[]
  /** The month's own time: the greyed days of its neighbours do not count. */
  readonly totalSeconds: number
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const parse = (value: string): Date => {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`invalid calendar date: ${value}`)
  return date
}

const iso = (date: Date): string => date.toISOString().slice(0, 10)

const shift = (value: string, days: number): string => {
  const date = parse(value)
  date.setUTCDate(date.getUTCDate() + days)
  return iso(date)
}

/** The 1st of the month a date falls in. */
export const monthStart = (within: string): string => {
  const date = parse(within)
  return iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)))
}

/** The last day of the month a date falls in. */
export const monthEnd = (within: string): string => {
  const date = parse(within)
  return iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)))
}

/** "October 2026": the month as the toolbar and the band above the grid name it. */
export const monthLabel = (within: string): string => {
  const date = parse(within)
  return `${MONTH_NAMES[date.getUTCMonth()]!} ${date.getUTCFullYear()}`
}

/**
 * The grid's range: whole weeks from the one holding the 1st to the one
 * holding the month's last day.
 */
export const calendarMonthRange = (
  within: string,
  weekStartDay: WeekStartDay,
): { readonly from: string; readonly to: string } => ({
  from: weekDates(monthStart(within), weekStartDay)[0]!,
  to: weekDates(monthEnd(within), weekStartDay)[6]!,
})

/** The weekday headings in the week's own order: "Mon … Sun" for a Monday start. */
export const weekdayHeadings = (weekStartDay: WeekStartDay): readonly string[] => {
  const start = weekStartDay === 'sunday' ? 0 : weekStartDay === 'monday' ? 1 : 6
  return Array.from({ length: 7 }, (_, index) => WEEKDAY_NAMES[(start + index) % 7]!)
}

/**
 * The month's weeks, each day with its entries in the order they were given
 * and its total. Entries outside the grid are ignored rather than refused:
 * the caller fetches a range, and a range is allowed to be generous.
 */
export const calendarMonth = <E extends CalendarEntry>(
  within: string,
  weekStartDay: WeekStartDay,
  entries: readonly E[],
): CalendarMonth<E> => {
  const start = monthStart(within)
  const end = monthEnd(within)
  const { from, to } = calendarMonthRange(within, weekStartDay)
  const byDate = new Map<string, E[]>()
  for (const entry of entries) {
    const list = byDate.get(entry.spent_date)
    if (list === undefined) byDate.set(entry.spent_date, [entry])
    else list.push(entry)
  }
  const weeks: CalendarCell<E>[][] = []
  let date = from
  while (date <= to) {
    const week: CalendarCell<E>[] = []
    for (let day = 0; day < 7; day += 1) {
      const onThisDay = byDate.get(date) ?? []
      week.push({
        date,
        inMonth: date >= start && date <= end,
        entries: onThisDay,
        totalSeconds: onThisDay.reduce((total, entry) => total + entry.seconds, 0),
      })
      date = shift(date, 1)
    }
    weeks.push(week)
  }
  const totalSeconds = weeks
    .flat()
    .filter((cell) => cell.inMonth)
    .reduce((total, cell) => total + cell.totalSeconds, 0)
  return { monthStart: start, from, to, weeks, totalSeconds }
}
