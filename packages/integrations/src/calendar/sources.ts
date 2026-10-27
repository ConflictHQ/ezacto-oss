import {
  CalendarAuthorizationError,
  CalendarConnectionError,
  CalendarCursorExpiredError,
  type CalendarSource,
  type CalendarSourceEvent,
} from '@ezacto/core'

/** Runtime-owned OAuth refresh supplies short-lived access tokens; never accepts a URL or a pasted token. */
export interface CalendarSourceOptions {
  getAccessToken(signal?: AbortSignal): Promise<string>
  fetch?: typeof globalThis.fetch
}

type RecordValue = Record<string, unknown>
const invalid = (): never => { throw new CalendarConnectionError('invalid') }
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : invalid()
const string = (value: unknown, max = 1024): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value : invalid()
const optional = (value: unknown, max = 16384): string | null =>
  value === undefined || value === null ? null : string(value, max)
const instant = (value: unknown): string => {
  const result = string(value, 64)
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-](\d\d):(\d\d))$/u.exec(result)
  if (!match || !Number.isFinite(Date.parse(result)) ||
    new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1] ||
    Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
    Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59 ||
    /[1-9]/u.test((match[5] ?? '').slice(3))) return invalid()
  return new Date(result).toISOString()
}
const summary = (value: unknown): string | null => value === undefined || value === null
  ? null : typeof value === 'string' && value.length <= 16384 ? value : invalid()

const read = async (url: URL, options: CalendarSourceOptions, signal?: AbortSignal, prefer?: string): Promise<RecordValue> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(abort, 25_000)
  try {
    controller.signal.throwIfAborted()
    const token = await options.getAccessToken(controller.signal)
    if (!token || token.length > 16384 || /\s/u.test(token)) throw new CalendarAuthorizationError()
    controller.signal.throwIfAborted()
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(prefer ? { prefer } : {}) },
    })
    if (response.status === 401 || response.status === 403) throw new CalendarAuthorizationError()
    if (response.status === 410) throw new CalendarCursorExpiredError()
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new CalendarConnectionError('unavailable')
    }
    const reader = response.body.getReader()
    let length = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        controller.signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 1024 * 1024) return invalid()
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (error) {
    if (error instanceof CalendarAuthorizationError || error instanceof CalendarCursorExpiredError || error instanceof CalendarConnectionError) throw error
    // Provider bodies, URLs, tokens and underlying transport messages never become diagnostics.
    throw new CalendarConnectionError('unavailable')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

const events = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 90) return invalid()
  return value
}
const base = (value: RecordValue): Pick<CalendarSourceEvent, 'calendarId' | 'eventId' | 'occurrence'> => ({
  calendarId: 'primary', eventId: string(value.id), occurrence: '',
})
// Both APIs return distinct, stable IDs for expanded occurrences. Keeping that
// full ID is also essential for deletion tombstones, which may contain only id.
const deleted = (value: RecordValue): CalendarSourceEvent => ({
  ...base(value), summary: null, startsAt: '', endsAt: '', allDay: false,
  cancelled: true, response: 'none', showAs: 'busy', version: 'deleted',
})

const googleEvent = (raw: unknown): CalendarSourceEvent => {
  const value = record(raw)
  if (value.status === 'cancelled') return deleted(value)
  if (value.status !== 'confirmed' && value.status !== 'tentative') return invalid()
  const start = record(value.start), end = record(value.end)
  const allDay = typeof start.date === 'string' && typeof end.date === 'string'
  let response: CalendarSourceEvent['response'] = 'none'
  if (value.organizer !== undefined && record(value.organizer).self === true) response = 'organizer'
  else if (value.attendees !== undefined) {
    if (!Array.isArray(value.attendees)) return invalid()
    const self = value.attendees.map(record).filter(attendee => attendee.self === true)
    if (self.length > 1) return invalid()
    const status = self[0]?.responseStatus
    if (status === 'accepted' || status === 'declined' || status === 'tentative') response = status
    else if (status !== undefined && status !== 'needsAction') return invalid()
  }
  if (value.transparency !== undefined && !['opaque', 'transparent'].includes(String(value.transparency))) return invalid()
  return {
    ...base(value), summary: summary(value.summary),
    startsAt: allDay ? '' : instant(start.dateTime), endsAt: allDay ? '' : instant(end.dateTime),
    allDay, cancelled: false, response,
    showAs: value.eventType === 'outOfOffice' ? 'oof' : value.transparency === 'transparent' ? 'free' : 'busy',
    version: string(value.etag, 256),
  }
}

export const createGoogleCalendarSource = (options: CalendarSourceOptions): CalendarSource => ({
  provider: 'google',
  async listEvents(request) {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('showDeleted', 'true')
    url.searchParams.set('maxResults', '90')
    url.searchParams.set('timeZone', 'UTC')
    if (request.cursor !== null) url.searchParams.set('syncToken', string(request.cursor, 16384))
    else {
      url.searchParams.set('timeMin', instant(request.window.from))
      url.searchParams.set('timeMax', instant(request.window.to))
    }
    if (request.page !== null) url.searchParams.set('pageToken', string(request.page, 16384))
    const body = await read(url, options, request.signal)
    const nextPage = optional(body.nextPageToken)
    const nextCursor = optional(body.nextSyncToken)
    if (nextPage === null && nextCursor === null) return invalid()
    return {
      events: events(body.items ?? []).map(googleEvent), nextPage, nextCursor: nextPage === null ? nextCursor : null,
      ...(request.cursor === null && nextPage === null ? { completeCalendarIds: ['primary'] } : {}),
    }
  },
})

const graphEndpoint = 'https://graph.microsoft.com/v1.0/me/calendarView/delta'
const graphLink = (value: string): URL => {
  try {
    const url = new URL(string(value, 16384))
    if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== '/v1.0/me/calendarView/delta' || url.username || url.password || url.hash) return invalid()
    return url
  } catch { return invalid() }
}
const graphTime = (raw: unknown): string => {
  const value = record(raw)
  if (value.timeZone !== 'UTC' && value.timeZone !== 'Etc/UTC') return invalid()
  const dateTime = string(value.dateTime, 64)
  return instant(/(?:Z|[+-]\d\d:\d\d)$/u.test(dateTime) ? dateTime : dateTime + 'Z')
}
const graphEvent = (raw: unknown): CalendarSourceEvent => {
  const value = record(raw)
  if (value['@removed'] !== undefined || value.isCancelled === true) return deleted(value)
  if (typeof value.isAllDay !== 'boolean' || typeof value.isOrganizer !== 'boolean') return invalid()
  const status = record(value.responseStatus).response
  const response: CalendarSourceEvent['response'] = value.isOrganizer ? 'organizer'
    : status === 'accepted' ? 'accepted'
      : status === 'declined' ? 'declined'
        : status === 'tentativelyAccepted' ? 'tentative'
          : status === 'none' || status === 'notResponded' || status === 'organizer' ? 'none' : invalid()
  const showAs = value.showAs === 'busy' || value.showAs === 'tentative' ? 'busy'
    : value.showAs === 'oof' ? 'oof'
      : value.showAs === 'free' || value.showAs === 'workingElsewhere' || value.showAs === 'unknown' ? 'free' : invalid()
  return {
    ...base(value), summary: summary(value.subject),
    startsAt: value.isAllDay ? '' : graphTime(value.start), endsAt: value.isAllDay ? '' : graphTime(value.end),
    allDay: value.isAllDay, cancelled: false, response, showAs,
    version: string(value.changeKey ?? value['@odata.etag'], 256),
  }
}

export const createMicrosoftCalendarSource = (options: CalendarSourceOptions): CalendarSource => ({
  provider: 'microsoft',
  async listEvents(request) {
    const continuation = request.page ?? request.cursor
    const url = continuation === null ? new URL(graphEndpoint) : graphLink(continuation)
    if (continuation === null) {
      url.searchParams.set('startDateTime', instant(request.window.from))
      url.searchParams.set('endDateTime', instant(request.window.to))
    }
    const body = await read(url, options, request.signal, 'IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=90')
    const nextPage = optional(body['@odata.nextLink'])
    const nextCursor = optional(body['@odata.deltaLink'])
    if (nextPage !== null) graphLink(nextPage)
    if (nextCursor !== null) graphLink(nextCursor)
    if ((nextPage === null) === (nextCursor === null)) return invalid()
    return {
      events: events(body.value).map(graphEvent), nextPage, nextCursor,
      ...(request.cursor === null && nextPage === null ? { completeCalendarIds: ['primary'] } : {}),
    }
  },
})
