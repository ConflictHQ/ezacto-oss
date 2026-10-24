/**
 * The capacity view's pure parts (issue 1007, slice 2): which days a screen asks
 * for, and how a figure reads. Kept apart from the DOM so they are tested
 * without one.
 *
 * Planned hours are a plan, not work. This screen only sets them beside the
 * person's capacity and what was tracked; nothing on it edits anything.
 */

export interface CapacityWeekData {
  readonly week_start: string
  readonly planned_seconds: number
  readonly time_off_seconds: number
  readonly available_capacity_seconds: number
  readonly tracked_seconds: number
  readonly over_allocated: boolean
}

export interface CapacityPersonData {
  readonly user_id: number
  readonly first_name: string
  readonly last_name: string
  readonly weekly_capacity_seconds: number
  readonly weeks: readonly CapacityWeekData[]
}

export interface CapacityData {
  readonly week_start_day: 'saturday' | 'sunday' | 'monday'
  readonly weeks: readonly string[]
  readonly people: readonly CapacityPersonData[]
}

export interface CapacityApi {
  getCapacity(
    range: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<{ readonly data: CapacityData }>
  /** Present only where administrator entry is offered. */
  readonly planning?: PlanningApi
}

/**
 * Administrator entry (issue 1007): the rows behind the grid and the calls that
 * change them. Only an administrator is given this; the server still decides
 * who may write.
 */
export interface AllocationRow {
  readonly id: number
  readonly user_id: number
  readonly project_id: number
  readonly start_date: string
  readonly end_date: string
  readonly planned_seconds_per_week: number
}

export const timeOffKinds = ['vacation', 'sick', 'holiday', 'other'] as const
export type TimeOffKindName = (typeof timeOffKinds)[number]

export interface TimeOffRow {
  readonly id: number
  readonly user_id: number
  readonly start_date: string
  readonly end_date: string
  readonly kind: TimeOffKindName
  readonly seconds_per_day: number | null
}

export interface PlanningRange {
  readonly from: string
  readonly to: string
}

export interface HolidayRow { readonly id: number; readonly date: string; readonly name: string; readonly version: number }
export interface HolidayApi {
  list(range: PlanningRange, signal?: AbortSignal): Promise<readonly HolidayRow[]>
  create(input: { date: string; name: string }, signal?: AbortSignal): Promise<unknown>
  update(id: number, input: { date: string; name: string; version: number }, signal?: AbortSignal): Promise<unknown>
  remove(id: number, version: number, signal?: AbortSignal): Promise<unknown>
}
export interface PlanningApi {
  readonly holidays?: HolidayApi
  listProjects(
    signal?: AbortSignal,
  ): Promise<readonly { readonly id: number; readonly name: string }[]>
  listAllocations(range: PlanningRange, signal?: AbortSignal): Promise<readonly AllocationRow[]>
  createAllocation(input: Omit<AllocationRow, 'id'>, signal?: AbortSignal): Promise<unknown>
  updateAllocation(
    id: number,
    patch: Partial<Omit<AllocationRow, 'id' | 'user_id' | 'project_id'>>,
    signal?: AbortSignal,
  ): Promise<unknown>
  deleteAllocation(id: number, signal?: AbortSignal): Promise<unknown>
  listTimeOff(range: PlanningRange, signal?: AbortSignal): Promise<readonly TimeOffRow[]>
  createTimeOff(input: Omit<TimeOffRow, 'id'>, signal?: AbortSignal): Promise<unknown>
  updateTimeOff(
    id: number,
    patch: Partial<Omit<TimeOffRow, 'id' | 'user_id'>>,
    signal?: AbortSignal,
  ): Promise<unknown>
  deleteTimeOff(id: number, signal?: AbortSignal): Promise<unknown>
}

/** Hours as typed (`7.5`) to whole seconds; null when it is not a positive number. */
export const hoursToSeconds = (text: string): number | null => {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const seconds = Math.round(Number(trimmed) * 3_600)
  return seconds >= 1 ? seconds : null
}

/** Seconds as the figure an hours field holds: `7.5`, `32`. */
export const secondsToHoursField = (seconds: number): string =>
  String(Math.round((seconds / 3_600) * 100) / 100)

/** Eight weeks at a time: a quarter of planning fits a screen without scrolling sideways. */
export const capacityWindowDays = 56

export const addCalendarDays = (date: string, days: number): string => {
  const moved = new Date(`${date}T00:00:00.000Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

/**
 * The days to ask for, `windows` windows away from the one holding `today`. The
 * server snaps both ends to its own week start day, so the screen need not know
 * what that is before it has asked.
 */
export const capacityRange = (
  today: string,
  windows: number,
): { readonly from: string; readonly to: string } => {
  const from = addCalendarDays(today, windows * capacityWindowDays)
  return { from, to: addCalendarDays(from, capacityWindowDays - 1) }
}

/** `32h`, `7.5h`, `0h`: tenths of an hour, no trailing zero. */
export const hoursText = (seconds: number): string => {
  const tenths = Math.round(seconds / 360)
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}h`
}

/**
 * One cell, as words, so the over-allocated flag never rests on colour alone. The
 * plan is held against the capacity left after time off, which is named when
 * there is any (administrator-entered, issue 1007 slice 3).
 */
export const capacityCellText = (
  week: Readonly<CapacityWeekData>,
): {
  readonly main: string
  readonly detail: string
  readonly timeOff: string | null
  readonly flag: string | null
} => ({
  main: `${hoursText(week.planned_seconds)} of ${hoursText(week.available_capacity_seconds)}`,
  detail: `${hoursText(week.tracked_seconds)} tracked`,
  timeOff: week.time_off_seconds > 0 ? `${hoursText(week.time_off_seconds)} time off` : null,
  flag: week.over_allocated ? 'Over-allocated' : null,
})

export const shortDate = (date: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00.000Z`),
  )

export const weekHeading = (weekStart: string): string => `Week of ${shortDate(weekStart)}`
