import { describe, expect, it } from 'vitest'
import {
  proposeEntriesFromEvents,
  recordedEventId,
  type CalendarEvent,
} from '../src/calendar/proposals.js'

/**
 * Issue 428, read-from direction. A proposal is a suggestion a person accepts
 * or discards, so the matching is allowed to be imperfect -- but it is not
 * allowed to be silent, and it is not allowed to offer the same meeting twice.
 */

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'evt-1',
  calendarId: 'primary',
  summary: 'Phase 1 review',
  startsAt: '2026-09-01T14:00:00Z',
  endsAt: '2026-09-01T15:30:00Z',
  ...overrides,
})

const propose = (events: readonly CalendarEvent[], recorded: string[] = []) =>
  proposeEntriesFromEvents({ events, recorded: new Set(recorded) })

describe('turning a calendar into proposals', () => {
  it('[unit] proposes an entry on the day the meeting started, for its exact length', () => {
    expect(propose([event()]).proposed).toEqual([
      {
        spentDate: '2026-09-01',
        seconds: 5_400,
        notes: 'Phase 1 review',
        calendarEventRef: { provider: 'google', eventId: 'evt-1', calendarId: 'primary' },
      },
    ])
  })

  it('[unit] never offers the same meeting twice', () => {
    // Sync on Friday, accept, sync again on Monday. Without this the person is
    // offered the whole week over again.
    const outcome = propose([event()], ['evt-1'])
    expect(outcome.proposed).toEqual([])
    expect(outcome.skipped).toEqual([{ eventId: 'evt-1', reason: 'already_recorded' }])
  })

  it('[unit] declines to invent a duration for an all-day event', () => {
    // The whole reason this direction is the safe one is that it does not make
    // up when work happened.
    const outcome = propose([event({ startsAt: null, endsAt: null })])
    expect(outcome.proposed).toEqual([])
    expect(outcome.skipped[0]?.reason).toBe('all_day')
  })

  it('[unit] skips a meeting this person declined', () => {
    expect(propose([event({ declined: true })]).skipped[0]?.reason).toBe('declined')
  })

  it('[unit] skips a slot marked free, which is a hold rather than work', () => {
    expect(propose([event({ transparent: true })]).skipped[0]?.reason).toBe('free_time')
  })

  it('[unit] skips an event that spans days rather than deciding how the week looked', () => {
    const outcome = propose([
      event({ startsAt: '2026-09-01T23:00:00Z', endsAt: '2026-09-02T01:00:00Z' }),
    ])
    expect(outcome.proposed).toEqual([])
    expect(outcome.skipped[0]?.reason).toBe('spans_days')
  })

  it('[unit] skips a zero-length event and one that ends before it starts', () => {
    expect(
      propose([event({ endsAt: '2026-09-01T14:00:00Z' })]).skipped[0]?.reason,
    ).toBe('zero_length')
    expect(
      propose([event({ endsAt: '2026-09-01T13:00:00Z' })]).skipped[0]?.reason,
    ).toBe('ends_before_it_starts')
  })

  it('[unit] gives an untitled event a note a person can read', () => {
    // An empty note is something the person has to decode rather than
    // recognise.
    expect(propose([event({ summary: '   ' })]).proposed[0]?.notes).toBe(
      'Untitled calendar event',
    )
    expect(propose([event({ summary: null })]).proposed[0]?.notes).toBe(
      'Untitled calendar event',
    )
  })

  it('[unit] accounts for every event it was given', () => {
    // A dropped event with no reason is a bug report nobody can write. The two
    // lists together have to add up to what came in.
    const events = [
      event({ id: 'a' }),
      event({ id: 'b', declined: true }),
      event({ id: 'c', startsAt: null, endsAt: null }),
      event({ id: 'd' }),
    ]
    const outcome = propose(events, ['d'])
    expect(outcome.proposed.length + outcome.skipped.length).toBe(events.length)
    expect([
      ...outcome.proposed.map((entry) => entry.calendarEventRef.eventId),
      ...outcome.skipped.map((skip) => skip.eventId),
    ].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('reading a stored reference back', () => {
  it('[unit] recovers the event id so the dedupe set can be built', () => {
    expect(recordedEventId({ provider: 'google', eventId: 'evt-9', calendarId: 'primary' })).toBe(
      'evt-9',
    )
  })

  it('[unit] answers nothing for a reference it does not recognise', () => {
    // `calendar_event_ref` is free-form JSON in the schema, so this will meet
    // shapes written before this module existed.
    for (const value of [null, undefined, 'evt-9', 42, {}, { eventId: '' }, { eventId: 7 }]) {
      expect(recordedEventId(value)).toBeNull()
    }
  })
})
