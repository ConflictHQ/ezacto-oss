import { describe, expect, it, vi } from 'vitest'
import { CalendarAuthorizationError, CalendarConnectionError, CalendarCursorExpiredError, calendarEventKey, planCalendarSync } from '@ezacto/core'
import { createGoogleCalendarSource, createMicrosoftCalendarSource } from '../src/calendar/sources.js'

const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' }
const request = { window, cursor: null, page: null }
const google = {
  id: 'series_20261010T150000Z', recurringEventId: 'series', status: 'confirmed', etag: 'v1',
  summary: 'Review', start: { dateTime: '2026-10-10T09:00:00-06:00' }, end: { dateTime: '2026-10-10T10:00:00-06:00' },
  attendees: [{ self: true, responseStatus: 'accepted' }],
}
const graph = {
  id: 'immutable-instance-id', type: 'occurrence', seriesMasterId: 'series', changeKey: 'v1',
  subject: 'Review', start: { dateTime: '2026-10-10T15:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-10T16:00:00.0000000', timeZone: 'UTC' },
  isAllDay: false, isOrganizer: false, responseStatus: { response: 'accepted' }, showAs: 'busy',
}
const delta = 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=opaque'
const transport = (...responses: Response[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const response of responses) fetch.mockResolvedValueOnce(response)
  return fetch
}
const options = (fetch: typeof globalThis.fetch) => ({ fetch, getAccessToken: vi.fn(async () => 'private-access-token') })
const googleBody = (items: unknown[]) => Response.json({ items, nextSyncToken: 'opaque-sync' })
const graphBody = (value: unknown[]) => Response.json({ value, '@odata.deltaLink': delta })

describe('read-only calendar provider transports', () => {
  it('maps Google instants and bounds the initial read without transmitting token in URL', async () => {
    const fetch = transport(googleBody([google]))
    const result = await createGoogleCalendarSource(options(fetch)).listEvents(request)
    expect(result.events[0]).toMatchObject({ eventId: google.id, occurrence: '', startsAt: '2026-10-10T15:00:00.000Z', endsAt: '2026-10-10T16:00:00.000Z', response: 'accepted' })
    const [input, init] = fetch.mock.calls[0]!
    const url = new URL(String(input))
    expect(url.origin).toBe('https://www.googleapis.com')
    expect(url.searchParams.get('timeMin')).toBe(window.from)
    expect(url.searchParams.get('timeMax')).toBe(window.to)
    expect(url.searchParams.get('showDeleted')).toBe('true')
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { authorization: 'Bearer private-access-token' } })
    expect(url.href).not.toContain('private-access-token')
  })

  it('keeps Google cursor/page tokens opaque and omits incompatible time bounds on incremental reads', async () => {
    const fetch = transport(Response.json({ items: [], nextPageToken: 'next+/=' }), googleBody([]))
    const source = createGoogleCalendarSource(options(fetch))
    const page = await source.listEvents({ ...request, cursor: 'old+/=' })
    expect(page).toEqual({ events: [], nextPage: 'next+/=', nextCursor: null })
    await source.listEvents({ ...request, cursor: 'old+/=', page: page.nextPage })
    for (const [input] of fetch.mock.calls) {
      const url = new URL(String(input))
      expect(url.searchParams.get('syncToken')).toBe('old+/=')
      expect(url.searchParams.has('timeMin')).toBe(false)
      expect(url.searchParams.has('timeMax')).toBe(false)
    }
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get('pageToken')).toBe('next+/=')
  })

  it('keeps Google recurrence cancellation identical to its earlier proposal key', async () => {
    const fetch = transport(googleBody([google]), googleBody([{ id: google.id, status: 'cancelled' }]))
    const source = createGoogleCalendarSource(options(fetch))
    const original = (await source.listEvents(request)).events[0]!
    const cancelled = (await source.listEvents({ ...request, cursor: 'old' })).events[0]!
    expect(calendarEventKey(cancelled)).toBe(calendarEventKey(original))
    expect(planCalendarSync([cancelled], new Map([[calendarEventKey(original), { status: 'proposed', version: original.version }]]))).toEqual([{ kind: 'cancel', event: cancelled }])
  })

  it('maps Google excluded and self-organized events without inventing all-day time', async () => {
    const fetch = transport(googleBody([
      { ...google, id: 'all-day', start: { date: '2026-10-10' }, end: { date: '2026-10-11' } },
      { ...google, id: 'declined', attendees: [{ self: true, responseStatus: 'declined' }] },
      { ...google, id: 'free', transparency: 'transparent' },
      { ...google, id: 'oof', eventType: 'outOfOffice' },
      { ...google, id: 'own', organizer: { self: true } },
    ]))
    const result = (await createGoogleCalendarSource(options(fetch)).listEvents(request)).events
    expect(result[0]).toMatchObject({ allDay: true, startsAt: '', endsAt: '' })
    expect(result.map(event => [event.response, event.showAs])).toEqual([
      ['accepted', 'busy'], ['declined', 'busy'], ['accepted', 'free'], ['accepted', 'oof'], ['organizer', 'busy'],
    ])
  })

  it('uses Graph immutable IDs and UTC headers on every continuation', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=page'
    const fetch = transport(Response.json({ value: [graph], '@odata.nextLink': next }), graphBody([]))
    const source = createMicrosoftCalendarSource(options(fetch))
    const first = await source.listEvents(request)
    expect(first.events[0]).toMatchObject({ eventId: graph.id, startsAt: '2026-10-10T15:00:00.000Z' })
    const second = await source.listEvents({ ...request, page: first.nextPage })
    expect(second.nextCursor).toBe(delta)
    expect(String(fetch.mock.calls[1]![0])).toBe(next)
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
      expect((init?.headers as Record<string, string>).prefer).toContain('IdType="ImmutableId"')
      expect((init?.headers as Record<string, string>).prefer).toContain('outlook.timezone="UTC"')
    }
  })

  it('matches a Graph ID-only tombstone to its original recurring proposal', async () => {
    const fetch = transport(graphBody([graph]), graphBody([{ id: graph.id, '@removed': { reason: 'deleted' } }]))
    const source = createMicrosoftCalendarSource(options(fetch))
    const original = (await source.listEvents(request)).events[0]!
    const cancelled = (await source.listEvents({ ...request, cursor: delta })).events[0]!
    expect(calendarEventKey(cancelled)).toBe(calendarEventKey(original))
    expect(planCalendarSync([cancelled], new Map([[calendarEventKey(original), { status: 'accepted', version: 'v1' }]]))).toEqual([{ kind: 'flag_changed', event: cancelled }])
  })

  it.each([
    'https://evil.example/v1.0/me/calendarView/delta?$skiptoken=secret',
    'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=secret',
    'https://user@graph.microsoft.com/v1.0/me/calendarView/delta',
    'https://graph.microsoft.com/v1.0/me/calendarView/delta#fragment',
  ])('refuses Graph continuation outside the fixed endpoint: %s', async cursor => {
    const fetch = transport(graphBody([]))
    await expect(createMicrosoftCalendarSource(options(fetch)).listEvents({ ...request, cursor })).rejects.toBeInstanceOf(CalendarConnectionError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses malicious next links before persisting them as cursors', async () => {
    const fetch = transport(Response.json({ value: [], '@odata.deltaLink': 'https://evil.example/' }))
    await expect(createMicrosoftCalendarSource(options(fetch)).listEvents(request)).rejects.toBeInstanceOf(CalendarConnectionError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([301, 302, 307, 308])('refuses HTTP %i without following or forwarding its token', async status => {
    for (const create of [createGoogleCalendarSource, createMicrosoftCalendarSource]) {
      const fetch = transport(new Response(null, { status, headers: { location: 'https://other.example/' } }))
      await expect(create(options(fetch)).listEvents(request)).rejects.toBeInstanceOf(CalendarConnectionError)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]![1]?.redirect).toBe('manual')
    }
  })

  it.each([401, 403, 410, 429, 503])('classifies HTTP %i without disclosing provider bodies', async status => {
    for (const create of [createGoogleCalendarSource, createMicrosoftCalendarSource]) {
      const fetch = transport(new Response('sensitive-provider-body', { status }))
      const expected = status === 401 || status === 403 ? CalendarAuthorizationError : status === 410 ? CalendarCursorExpiredError : CalendarConnectionError
      const error = await create(options(fetch)).listEvents(request).catch(error => error)
      expect(error).toBeInstanceOf(expected)
      expect(error.message).not.toContain('sensitive-provider-body')
    }
  })

  it('rejects oversized and malformed provider responses', async () => {
    for (const body of [new Response('x'.repeat(1024 * 1024 + 1)), googleBody(Array(91).fill(google)), googleBody([{ ...google, start: { dateTime: 'bad' } }])]) {
      await expect(createGoogleCalendarSource(options(transport(body))).listEvents(request)).rejects.toBeInstanceOf(CalendarConnectionError)
    }
    await expect(createMicrosoftCalendarSource(options(transport(graphBody([{ ...graph, start: { dateTime: '2026-10-10T10:00:00', timeZone: 'Pacific Standard Time' } }])))).listEvents(request)).rejects.toBeInstanceOf(CalendarConnectionError)
  })

  it.each(['2026-02-30T10:00:00Z', '2026-10-10T24:00:00Z', '2026-10-10T10:00:00.0001Z'])('refuses normalized or unrepresentable instant %s', async dateTime => {
    await expect(createGoogleCalendarSource(options(transport(googleBody([{ ...google, start: { dateTime } }])))).listEvents(request)).rejects.toBeInstanceOf(CalendarConnectionError)
  })

  it('does not start token lookup or transport for an already aborted read', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = transport(googleBody([])), auth = options(fetch)
    await expect(createGoogleCalendarSource(auth).listEvents({ ...request, signal: controller.signal })).rejects.toBeInstanceOf(CalendarConnectionError)
    expect(auth.getAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
