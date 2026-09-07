import type { GeneralResource, TimeEntry } from '@ezacto/client'
import type { DisplayTimeEntry, ShellApi, ShellSnapshot } from '../shell/model.js'

export interface WeekRowSeed {
  readonly projectId: number
  readonly taskId: number
}

export interface WeekGridCell {
  readonly key: string
  readonly date: string
  readonly projectId: number
  readonly taskId: number
  readonly entries: readonly DisplayTimeEntry[]
  readonly totalSeconds: number
  readonly notes: string | null
  readonly minimumNoteLength: number
  readonly isConflict: boolean
  readonly isLocked: boolean
  readonly lockedReason: string | null
  readonly isRunning: boolean
}

export interface WeekGridRow {
  readonly key: string
  readonly projectId: number
  readonly taskId: number
  readonly projectLabel: string
  readonly taskLabel: string
  readonly cells: readonly WeekGridCell[]
  readonly totalSeconds: number
  readonly isRunning: boolean
}

export interface WeekGrid {
  readonly dates: readonly string[]
  readonly rows: readonly WeekGridRow[]
  readonly dayTotals: readonly number[]
  readonly totalSeconds: number
}

export type WeekCellSaveResult =
  | { readonly state: 'saved'; readonly entry: TimeEntry | null }
  | {
      readonly state: 'retry'
      readonly rawValue: string
      readonly message: string
      readonly error: unknown
      retry(): Promise<WeekCellSaveResult>
    }

const text = (resource: GeneralResource, field: string): string | null => {
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const catalogLabels = (resources: readonly GeneralResource[]): ReadonlyMap<number, string> =>
  new Map(
    resources.map((resource) => [
      resource.id,
      text(resource, 'name') ?? text(resource, 'code') ?? `#${resource.id}`,
    ]),
  )

export const weekDates = (
  within: string,
  weekStartDay: 'saturday' | 'sunday' | 'monday' = 'monday',
): readonly string[] => {
  const date = new Date(`${within}T00:00:00.000Z`)
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== within) {
    throw new Error(`invalid week date: ${within}`)
  }
  const startIndex = weekStartDay === 'sunday' ? 0 : weekStartDay === 'monday' ? 1 : 6
  const daysSinceStart = (date.getUTCDay() - startIndex + 7) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceStart)
  return Array.from({ length: 7 }, (_value, index) => {
    const day = new Date(date)
    day.setUTCDate(day.getUTCDate() + index)
    return day.toISOString().slice(0, 10)
  })
}

const rowKey = (projectId: number, taskId: number): string => `${projectId}:${taskId}`

export const buildWeekGrid = (
  snapshot: ShellSnapshot,
  within: string,
  supplementalRows: readonly WeekRowSeed[] = [],
): WeekGrid => {
  const dates = weekDates(within, snapshot.timeEntrySettings.week_start_day)
  const dateSet = new Set(dates)
  const entries = snapshot.entries.filter((entry) => dateSet.has(entry.spent_date))
  const rowSeeds = new Map<string, WeekRowSeed>()
  for (const seed of supplementalRows) rowSeeds.set(rowKey(seed.projectId, seed.taskId), seed)
  for (const entry of entries) {
    const seed = { projectId: entry.project_id, taskId: entry.task_id }
    rowSeeds.set(rowKey(seed.projectId, seed.taskId), seed)
  }
  const projects = catalogLabels(snapshot.catalog.projects)
  const tasks = catalogLabels(snapshot.catalog.tasks)
  const options = new Map(
    snapshot.catalog.timeEntryOptions.map((option) => [
      rowKey(option.project_id, option.task_id),
      option,
    ]),
  )
  const rows = [...rowSeeds.values()]
    .map((seed): WeekGridRow => {
      const matching = entries.filter(
        (entry) => entry.project_id === seed.projectId && entry.task_id === seed.taskId,
      )
      const cells = dates.map((date): WeekGridCell => {
        const cellEntries = matching.filter((entry) => entry.spent_date === date)
        const optionMinimum =
          options.get(rowKey(seed.projectId, seed.taskId))
            ?.minimum_note_length ?? 0
        return {
          key: `${rowKey(seed.projectId, seed.taskId)}:${date}`,
          date,
          projectId: seed.projectId,
          taskId: seed.taskId,
          entries: cellEntries,
          totalSeconds: cellEntries.reduce((total, entry) => total + entry.seconds, 0),
          notes: cellEntries.length === 1 ? (cellEntries[0]!.notes ?? null) : null,
          minimumNoteLength:
            cellEntries.length === 1
              ? Math.max(cellEntries[0]!.minimum_note_length, optionMinimum)
              : optionMinimum,
          isConflict: cellEntries.length > 1,
          isLocked: cellEntries.some((entry) => entry.is_locked),
          lockedReason:
            cellEntries.find(
              (entry) =>
                entry.is_locked &&
                entry.locked_reason !== null &&
                entry.locked_reason !== undefined,
            )?.locked_reason ?? null,
          isRunning: cellEntries.some((entry) => entry.is_running),
        }
      })
      return {
        key: rowKey(seed.projectId, seed.taskId),
        projectId: seed.projectId,
        taskId: seed.taskId,
        projectLabel: projects.get(seed.projectId) ?? `#${seed.projectId}`,
        taskLabel: tasks.get(seed.taskId) ?? `#${seed.taskId}`,
        cells,
        totalSeconds: cells.reduce((total, cell) => total + cell.totalSeconds, 0),
        isRunning: matching.some((entry) => entry.is_running),
      }
    })
    .sort((left, right) =>
      `${left.projectLabel}\u0000${left.taskLabel}`.localeCompare(
        `${right.projectLabel}\u0000${right.taskLabel}`,
      ),
    )
  const dayTotals = dates.map((_date, index) =>
    rows.reduce((total, row) => total + row.cells[index]!.totalSeconds, 0),
  )
  return {
    dates,
    rows,
    dayTotals,
    totalSeconds: dayTotals.reduce((total, seconds) => total + seconds, 0),
  }
}

/**
 * The one place seconds become a duration on screen. A cell, its own row total,
 * the tfoot, the week total and the day strip all render the same seconds, so
 * they have to round them the same way and to the same precision: 8130s
 * reading `2:16` in a cell above `2:15` in that cell's own total is issue 295,
 * and it survived the first fix because the two formatters only agreed on
 * whole minutes.
 *
 * The rounding rule is the cell's, not the totals'. Rounding to the nearest
 * minute is the honest reading of 2h15m30s, where flooring loses up to 59
 * seconds of every duration; and decimal keeps four places because a cell is
 * an input, so `parseCellSeconds` has to read back exactly the seconds the
 * cell shows — at two places a one-second entry renders `0.00` and reparses to
 * nothing.
 *
 * Signed, because an imported Harvest correction entry is negative (issue 279)
 * and a cell holding one has to show it rather than throw. The magnitude is
 * split and then signed: flooring a negative directly borrowed an hour and
 * rendered -1800s as "-1:30". `parseCellSeconds` stays non-negative — reading a
 * correction is not the same as typing one.
 */
export const formatDuration = (
  seconds: number,
  timeFormat: 'decimal' | 'hours_minutes' = 'decimal',
): string => {
  const sign = seconds < 0 ? '-' : ''
  const magnitude = Math.abs(seconds)
  if (timeFormat === 'hours_minutes') {
    const totalMinutes = Math.round(magnitude / 60)
    return `${sign}${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`
  }
  const hours = magnitude / 3_600
  const rendered = Number.isInteger(hours)
    ? String(hours)
    : hours.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '')
  return `${sign}${rendered}`
}

/**
 * `formatDuration` for the editable cell, which is the one surface that leaves
 * zero blank: an empty cell means "nothing logged", whereas a total of zero is
 * a fact worth showing.
 */
export const formatCellHours = (
  seconds: number,
  timeFormat: 'decimal' | 'hours_minutes' = 'decimal',
): string => {
  if (!Number.isSafeInteger(seconds)) throw new Error('invalid cell seconds')
  if (seconds === 0) return ''
  return formatDuration(seconds, timeFormat)
}

export const parseCellSeconds = (rawValue: string): number => {
  const value = rawValue.trim()
  if (value === '') return 0
  const clock = /^(\d+):([0-5]\d)$/u.exec(value)
  if (clock !== null) {
    const seconds = Number(clock[1]) * 3_600 + Number(clock[2]) * 60
    if (seconds > 86_400) throw new Error('cell duration cannot exceed 24 hours')
    return seconds
  }
  if (!/^\d+(?:\.\d{1,4})?$/u.test(value)) {
    throw new Error('use decimal hours or H:MM')
  }
  const seconds = Math.round(Number(value) * 3_600)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new Error('cell duration must be between 1 second and 24 hours')
  }
  return seconds
}

const saveWeekCell = async (
  api: ShellApi,
  cell: WeekGridCell,
  rawValue: string,
  notes?: string | null,
  signal?: AbortSignal,
): Promise<TimeEntry | null> => {
  if (cell.isConflict) throw new Error('multiple entries share this cell; edit them in day view')
  if (cell.isLocked) throw new Error('this cell is locked')
  if (cell.isRunning) throw new Error('stop the running timer before editing this cell')
  const seconds = parseCellSeconds(rawValue)
  const existing = cell.entries[0]
  if (seconds === 0) {
    if (existing !== undefined) {
      if (signal === undefined) await api.deleteTimeEntry(existing.id)
      else await api.deleteTimeEntry(existing.id, signal)
    }
    return null
  }
  if (existing === undefined) {
    const input = {
      project_id: cell.projectId,
      task_id: cell.taskId,
      spent_date: cell.date,
      seconds,
      ...(notes === undefined ? {} : { notes }),
    }
    return signal === undefined
      ? api.createTimeEntry(input)
      : api.createTimeEntry(input, signal)
  }
  const patch = {
    seconds,
    ...(notes === undefined ? {} : { notes }),
  }
  return signal === undefined
    ? api.updateTimeEntry(existing.id, patch)
    : api.updateTimeEntry(existing.id, patch, signal)
}

export const saveWeekCellWithRetry = async (
  api: ShellApi,
  cell: WeekGridCell,
  rawValue: string,
  notes?: string | null,
  signal?: AbortSignal,
): Promise<WeekCellSaveResult> => {
  try {
    return {
      state: 'saved',
      entry: await saveWeekCell(api, cell, rawValue, notes, signal),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'time could not be saved'
    return {
      state: 'retry',
      rawValue,
      message,
      error,
      retry: () => saveWeekCellWithRetry(api, cell, rawValue, notes, signal),
    }
  }
}

export const seedsFromEntries = (
  entries: readonly Pick<TimeEntry, 'project_id' | 'task_id'>[],
): readonly WeekRowSeed[] => [
  ...new Map(
    entries.map((entry) => [
      rowKey(entry.project_id, entry.task_id),
      { projectId: entry.project_id, taskId: entry.task_id },
    ]),
  ).values(),
]
