import type { TimeEntry } from '@ezacto/client'

export type TimeEntryMode = 'duration' | 'start_end'
export type OrganizationClock = '12h' | '24h'
export type EntryEditorContext = 'week-cell' | 'day' | 'quick-add' | 'edit' | 'timer'

export interface TimeEntrySettings {
  readonly time_entry_mode: TimeEntryMode
  readonly time_format: 'decimal' | 'hours_minutes'
  readonly clock: OrganizationClock
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
  if (context === 'quick-add') return 'Quick add time'
  if (context === 'timer') return editing ? 'Running timer' : 'Start a timer'
  if (context === 'day') return editing ? 'Edit day entry' : 'Add day entry'
  if (context === 'week-cell') return editing ? 'Edit week entry' : 'Add week entry'
  return 'Edit time entry'
}
