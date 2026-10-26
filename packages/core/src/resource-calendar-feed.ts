import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { escapeIcsText, foldIcsLine } from './planning-ics.js'
import { addDays, isAllocationDate } from './allocation.js'
import type { ResourceCalendarProjection } from './resource-calendar.js'

/** Bound reconciliation below D1's 2 MB row limit, including cancellation records. */
export const maximumCalendarFeedEvents = 2000
export const maximumCalendarFeedStateBytes = 1_000_000
const digest = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
const uidFor = (namespace: string, key: string) => `${bytesToHex(hmac(sha256, new TextEncoder().encode(namespace), new TextEncoder().encode(key)))}@calendar.ezacto`

export class CalendarFeedInputError extends Error {
  readonly code = 'calendar_feed_invalid' as const
  constructor(message = 'The advisory calendar cannot be produced for this scope.') { super(message); this.name = 'CalendarFeedInputError' }
}

/** A whitelisted weekly advisory fact: no tracked entries, notes, money or leave reasons. */
export interface CalendarFeedFact {
  readonly key: string
  readonly startDate: string
  readonly endDateExclusive: string
  readonly summary: string
  readonly description: string
}
/** Persist only reconciliation metadata. Present labels are read afresh, never retained here. */
export interface CalendarFeedEventState {
  readonly key: string
  readonly uid: string
  readonly sequence: number
  readonly changedAt: string
  readonly startDate: string
  readonly endDateExclusive: string
  readonly fingerprint: string
  readonly cancelled: boolean
}
export interface CalendarFeedEvent extends CalendarFeedEventState {
  readonly summary: string
  readonly description: string
}

const secondsText = (seconds: number): string => {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new CalendarFeedInputError()
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', remainder ? `${remainder}s` : ''].filter(Boolean).join(' ') || '0h'
}
// RFC 5545 INTEGER values are signed 32-bit; SEQUENCE is non-negative.
const validSequence = (sequence: number): boolean => Number.isInteger(sequence) && sequence >= 0 && sequence <= 2_147_483_647
const validDates = (start: string, end: string) => isAllocationDate(start) && isAllocationDate(end) && start < end
const utcStamp = (instant: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant) || !Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString() !== instant) throw new CalendarFeedInputError()
  return instant.replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z')
}

/** Uses the shared projection's whole-week rules; partial-day leave remains an availability amount. */
export const calendarFeedFacts = (projection: ResourceCalendarProjection, options: { includeNames: boolean }): CalendarFeedFact[] => {
  if (projection.nextCursor !== null || projection.unassignedTruncated) throw new CalendarFeedInputError('Narrow the calendar scope before exporting it.')
  const facts: CalendarFeedFact[] = []
  for (const person of projection.people) {
    for (const week of person.weeks) {
      const planned = secondsText(week.plannedSeconds)
      const suffix = options.includeNames ? ` · ${person.name}` : ''
      const identity = [person.personId, week.weekStart]
      const dates = { startDate: week.weekStart, endDateExclusive: addDays(week.weekStart, 7) }
      if (week.plannedSeconds > 0) facts.push({
        key: digest(['planned', ...identity]), ...dates,
        summary: `${planned} planned${suffix}`,
        description: 'Advisory weekly plan. The full weekly amount counts for every week an allocation touches, including a partial week. This is not an appointment or actual work.',
      })
      facts.push({
        key: digest(['availability', ...identity]), ...dates,
        summary: `${secondsText(week.availableSeconds)} available${suffix}`,
        description: `Advisory whole-person availability after leave and holidays. ${secondsText(week.personPlannedSeconds)} planned across all work. Partial-day leave is an amount, not an invented busy appointment.`,
      })
    }
  }
  for (const demand of projection.unassigned) facts.push({
    key: digest(['unassigned', demand.placeholderId, demand.weekStart]),
    startDate: demand.weekStart, endDateExclusive: addDays(demand.weekStart, 7),
    summary: `${secondsText(demand.plannedSeconds)} unassigned planned work${options.includeNames ? ` · ${demand.name}` : ''}`,
    description: 'Advisory unassigned weekly demand. This is not a person, availability or actual work. The full weekly amount counts for every week the saved range touches.',
  })
  if (facts.length > maximumCalendarFeedEvents) throw new CalendarFeedInputError('Narrow the calendar scope before exporting it.')
  return facts
}

/** Stable opaque UIDs, persisted monotonic sequences and explicit removed-event tombstones.
 * Namespace is private random per-feed material, separate from its public id and credential.
 * The native store must CAS this result together with a fresh owner/scope/credential proof. */
export const reconcileCalendarFeed = (namespace: string, previous: readonly CalendarFeedEventState[], facts: readonly CalendarFeedFact[], now: string): { state: CalendarFeedEventState[]; events: CalendarFeedEvent[] } => {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(namespace)) throw new CalendarFeedInputError()
  utcStamp(now)
  if (previous.length > maximumCalendarFeedEvents || facts.length > maximumCalendarFeedEvents) throw new CalendarFeedInputError('Narrow the calendar scope before exporting it.')
  const old = new Map<string, CalendarFeedEventState>()
  for (const item of previous) {
    if (old.has(item.key) || !/^[a-f0-9]{64}$/.test(item.key) || !/^[a-f0-9]{64}$/.test(item.fingerprint) || typeof item.cancelled !== 'boolean' || !validSequence(item.sequence) || !validDates(item.startDate, item.endDateExclusive) || item.uid !== uidFor(namespace, item.key)) throw new CalendarFeedInputError()
    utcStamp(item.changedAt); old.set(item.key, item)
  }
  const events: CalendarFeedEvent[] = [], seen = new Set<string>()
  for (const fact of facts) {
    if (seen.has(fact.key) || !/^[a-f0-9]{64}$/.test(fact.key) || !validDates(fact.startDate, fact.endDateExclusive) || fact.summary.length > 2048 || fact.description.length > 4096) throw new CalendarFeedInputError()
    seen.add(fact.key)
    const before = old.get(fact.key), fingerprint = digest([fact.startDate, fact.endDateExclusive, fact.summary, fact.description])
    const changed = before === undefined || before.cancelled || before.fingerprint !== fingerprint
    const sequence = before === undefined ? 0 : before.sequence + Number(changed)
    if (!validSequence(sequence)) throw new CalendarFeedInputError()
    events.push({ ...fact, uid: uidFor(namespace, fact.key), fingerprint, sequence, cancelled: false, changedAt: before && (!changed || before.changedAt > now) ? before.changedAt : now })
  }
  for (const before of previous) {
    if (seen.has(before.key)) continue
    const sequence = before.sequence + Number(!before.cancelled)
    if (!validSequence(sequence)) throw new CalendarFeedInputError()
    events.push({ ...before, sequence, cancelled: true, changedAt: before.cancelled || before.changedAt > now ? before.changedAt : now, summary: 'Removed advisory information', description: '' })
  }
  if (events.length > maximumCalendarFeedEvents) throw new CalendarFeedInputError('The calendar reconciliation limit has been reached. Narrow the scope or issue a new subscription.')
  events.sort((a, b) => a.key.localeCompare(b.key))
  const state = events.map(({ key, uid, sequence, changedAt, startDate, endDateExclusive, fingerprint, cancelled }) => ({ key, uid, sequence, changedAt, startDate, endDateExclusive, fingerprint, cancelled }))
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > maximumCalendarFeedStateBytes) throw new CalendarFeedInputError('The calendar reconciliation limit has been reached. Narrow the scope or issue a new subscription.')
  return { events, state }
}

/** Share the public planning ICS encoder; reject raw newlines before folding. */
export const escapeCalendarText = escapeIcsText
export const foldCalendarLine = (value: string): string => {
  if (/[\r\n]/.test(value)) throw new CalendarFeedInputError()
  return foldIcsLine(value)
}

export const serializeCalendarFeed = (events: readonly CalendarFeedEvent[]): string => {
  if (events.length > maximumCalendarFeedEvents) throw new CalendarFeedInputError()
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ConflictHQ//eZacto advisory planning//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:eZacto advisory planning']
  const uids = new Set<string>()
  for (const event of events) {
    if (!/^[a-f0-9]{64}@calendar\.ezacto$/.test(event.uid) || uids.has(event.uid) || !validSequence(event.sequence) || !validDates(event.startDate, event.endDateExclusive)) throw new CalendarFeedInputError()
    uids.add(event.uid)
    const stamp = utcStamp(event.changedAt)
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `SEQUENCE:${event.sequence}`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`, `DTSTART;VALUE=DATE:${event.startDate.replaceAll('-', '')}`, `DTEND;VALUE=DATE:${event.endDateExclusive.replaceAll('-', '')}`, `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:TRANSPARENT', 'CLASS:PRIVATE', `SUMMARY:${escapeCalendarText(event.summary)}`, `DESCRIPTION:${escapeCalendarText(event.description)}`, 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldCalendarLine).join('\r\n')}\r\n`
}
