import { describe, expect, it } from 'vitest'
import { CalendarSyncLimitError, calendarEventKey, runCalendarSync, type CalendarSource, type CalendarSourceEvent, type CalendarProposalSnapshot } from '../src/calendar-sync.js'

const event: CalendarSourceEvent = {
  calendarId: 'primary', eventId: 'kept', occurrence: '', summary: 'Meeting',
  startsAt: '2026-10-10T15:00:00Z', endsAt: '2026-10-10T16:00:00Z',
  allDay: false, cancelled: false, response: 'accepted', showAs: 'busy', version: 'v1',
}
const key = (id: string, calendarId = 'primary') => calendarEventKey({ calendarId, eventId: id, occurrence: '' })
const held = (): Map<string, CalendarProposalSnapshot> => new Map([
  [key('kept'), { status: 'proposed', version: 'v1' }],
  [key('removed'), { status: 'proposed', version: 'v1' }],
  [key('accepted'), { status: 'accepted', version: 'v1' }],
  [key('discarded'), { status: 'discarded', version: 'v1' }],
  [key('other', 'another-calendar'), { status: 'proposed', version: 'v1' }],
])
const run = (source: CalendarSource, cursor: string | null = null, existing = held()) => runCalendarSync({
  source, cursor, existing, now: '2026-10-15T00:00:00Z',
})

describe('full-window calendar reconciliation', () => {
  it('withdraws absent proposals and flags accepted entries only after the complete final page', async () => {
    const pages: Array<string | null> = []
    const result = await run({ provider: 'google', async listEvents(request) {
      pages.push(request.page)
      return request.page === null
        ? { events: [event], nextPage: 'next', nextCursor: null }
        : { events: [], nextPage: null, nextCursor: 'cursor', completeCalendarIds: ['primary'] }
    } })
    expect(pages).toEqual([null, 'next'])
    expect(result.status).toBe('connected')
    expect(result.actions.map(action => [action.kind, action.event.eventId])).toEqual([
      ['cancel', 'removed'], ['flag_changed', 'accepted'],
    ])
  })
  it('does not infer missing events from an incremental or unmarked result', async () => {
    for (const cursor of [null, 'incremental']) {
      const result = await run({ provider: 'google', async listEvents() {
        return { events: [], nextPage: null, nextCursor: 'next' }
      } }, cursor)
      expect(result.actions).toEqual([])
    }
  })
  it('refuses claimed completeness on a partial page or incremental result', async () => {
    for (const [cursor, nextPage] of [[null, 'more'], ['old', null]] as const) {
      await expect(run({ provider: 'google', async listEvents() {
        return { events: [], nextPage, nextCursor: null, completeCalendarIds: ['primary'] }
      } }, cursor)).rejects.toBeInstanceOf(CalendarSyncLimitError)
    }
  })
  it('returns no partial plan if the final page fails', async () => {
    await expect(run({ provider: 'google', async listEvents(request) {
      if (request.page !== null) throw new Error('offline')
      return { events: [event], nextPage: 'more', nextCursor: null }
    } })).rejects.toThrow('offline')
  })
  it('bounds inferred actions as well as received events', async () => {
    const existing = new Map<string, CalendarProposalSnapshot>(Array.from({ length: 91 }, (_, i) => [key(String(i)), { status: 'proposed', version: 'v1' }]))
    await expect(run({ provider: 'google', async listEvents() {
      return { events: [], nextPage: null, nextCursor: 'next', completeCalendarIds: ['primary'] }
    } }, null, existing)).rejects.toBeInstanceOf(CalendarSyncLimitError)
  })
})
