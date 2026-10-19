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
}

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

/** One cell, as words, so the over-allocated flag never rests on colour alone. */
export const capacityCellText = (
  week: Readonly<CapacityWeekData>,
  capacitySeconds: number,
): { readonly main: string; readonly detail: string; readonly flag: string | null } => ({
  main: `${hoursText(week.planned_seconds)} of ${hoursText(capacitySeconds)}`,
  detail: `${hoursText(week.tracked_seconds)} tracked`,
  flag: week.over_allocated ? 'Over-allocated' : null,
})

export const shortDate = (date: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00.000Z`),
  )

export const weekHeading = (weekStart: string): string => `Week of ${shortDate(weekStart)}`
