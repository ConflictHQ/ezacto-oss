import {
  describeTimeRounding,
  effectiveTimeRounding,
  assertTimeRoundingPolicy,
  roundTimeSeconds,
  type EffectiveTimeRounding,
  type TimeRoundingMinutes,
  type TimeRoundingPolicy,
  type TimeRoundingMode,
} from '@ezacto/core'
import type { TimeEntry } from '@conflict-hq/ezacto-client'

export type TimeEntryMode = 'duration' | 'start_end'
export type OrganizationClock = '12h' | '24h'
/**
 * Where the editor was opened from. `calendar` is a new entry drawn on the
 * calendar (issue 943): it opens with its times already set and the note
 * waiting, and Enter in the note saves it.
 */
export type EntryEditorContext = 'week-cell' | 'day' | 'quick-add' | 'edit' | 'timer' | 'calendar' | 'proposal'

export interface TimeEntrySettings {
  readonly time_entry_mode: TimeEntryMode
  readonly time_format: 'decimal' | 'hours_minutes'
  readonly clock: OrganizationClock
  readonly week_start_day: 'saturday' | 'sunday' | 'monday'
  /** The organization's rounding rule; a project may set its own. */
  readonly time_rounding: { readonly mode: TimeRoundingMode; readonly minutes: TimeRoundingMinutes }
}

export interface EntryEditorDraft {
  readonly context: EntryEditorContext
  readonly entry: TimeEntry | null
  readonly projectId: number
  readonly taskId: number
  readonly spentDate: string
  readonly seconds: number
  readonly notes: string | null
  readonly minimumNoteLength: number
}

const canonicalTimePattern = /^(\d{2}):([0-5]\d)$/u

const canonicalParts = (value: string): { hours: number; minutes: string } => {
  const match = canonicalTimePattern.exec(value)
  const hours = Number(match?.[1])
  if (match === null || hours > 23) throw new Error('time must be canonical HH:MM')
  return { hours, minutes: match[2]! }
}

export const formatTimeForClock = (
  canonical: string,
  clock: OrganizationClock,
): string => {
  const { hours, minutes } = canonicalParts(canonical)
  if (clock === '24h') return canonical
  const meridiem = hours < 12 ? 'AM' : 'PM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${minutes} ${meridiem}`
}

export const parseTimeForClock = (
  displayed: string,
  clock: OrganizationClock,
): string => {
  const value = displayed.trim()
  if (clock === '24h') {
    canonicalParts(value)
    return value
  }
  const match = /^(\d{1,2}):([0-5]\d)\s*([ap]m)$/iu.exec(value)
  const hours = Number(match?.[1])
  if (match === null || hours < 1 || hours > 12) {
    throw new Error('time must look like 9:05 AM or 5:30 PM')
  }
  const meridiem = match[3]!.toLocaleLowerCase('en-US')
  const canonicalHours = (hours % 12) + (meridiem === 'pm' ? 12 : 0)
  return `${String(canonicalHours).padStart(2, '0')}:${match[2]}`
}

export const modeForEntryDraft = (
  entry: TimeEntry | null,
  organizationMode: TimeEntryMode,
): TimeEntryMode =>
  entry === null
    ? organizationMode
    : entry.started_time === null || entry.started_time === undefined
      ? 'duration'
      : 'start_end'

export const contextLabel = (context: EntryEditorContext, editing: boolean): string => {
  if (context === 'proposal') return 'Review calendar proposal'
  if (context === 'timer') return editing ? 'Running timer' : 'Start a timer'
  return editing ? 'Edit time entry' : 'Add time entry'
}

/**
 * Seconds between two canonical times, an end before the start being past
 * midnight, as the API reads it.
 */
export const secondsBetweenTimes = (started: string, ended: string): number => {
  const start = canonicalParts(started)
  const end = canonicalParts(ended)
  const minutes = end.hours * 60 + Number(end.minutes) - (start.hours * 60 + Number(start.minutes))
  return (minutes < 0 ? minutes + 24 * 60 : minutes) * 60
}

/**
 * What an entry will bill as under the rule of its project, in the editor's own
 * words: `Bills as 1.25 h \u00b7 rounded up to 15 min (project setting)`.
 */
export const billsAsText = (seconds: number, rule: Readonly<EffectiveTimeRounding>): string => {
  const hours = (roundTimeSeconds(seconds, rule) / 3600).toFixed(2)
  return `Bills as ${hours} h \u00b7 ${roundingWithSource(rule)}`
}

/**
 * The rule that applies to a project, read off the project record. A project
 * record carries its own rule only for someone with commercial authority, so
 * a record without the fields says nothing about a rule, which is `undefined`,
 * and a record with both null takes the organization's.
 */
export const projectTimeRounding = (
  project: Readonly<Record<string, unknown>>,
  organization: Readonly<TimeRoundingPolicy>,
): EffectiveTimeRounding | undefined => {
  if (!('time_rounding_mode' in project) || !('time_rounding_minutes' in project)) return undefined
  const mode = project['time_rounding_mode']
  const minutes = project['time_rounding_minutes']
  return effectiveTimeRounding(
    organization,
    mode === null || mode === undefined
      ? null
      : assertTimeRoundingPolicy({ mode, minutes }),
  )
}

/** `rounded up to 15 min (project setting)`, or `not rounded (organization setting)`. */
export const roundingWithSource = (rule: Readonly<EffectiveTimeRounding>): string =>
  `${rule.mode === 'exact' ? 'not rounded' : describeTimeRounding(rule)} (${rule.source === 'project' ? 'project' : 'organization'} setting)`
