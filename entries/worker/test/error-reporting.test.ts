import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import { ApiError } from '@ezacto/api'
import { captureWorkerError, reportWorkerError, scrubWorkerEvent } from '../src/error-reporting.js'
import type { ErrorEvent } from '@sentry/cloudflare'

vi.mock('@sentry/cloudflare', async original => ({ ...(await original<object>()), captureException: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())
const release = 'a'.repeat(40)
const requestId = '11111111-1111-4111-8111-111111111111'
const traceId = 'b'.repeat(32)

it('rebuilds automatic SDK events without private scope, message, request or source-context data', () => {
  const secret = 'SECRET_provider_body_SQL_cookie_person@example.test'
  const event = {
    event_id: 'c'.repeat(32), release, environment: 'prod', message: secret, user: { email: secret },
    request: { url: 'https://private.invalid/?token=' + secret, headers: { authorization: secret }, data: secret },
    extra: { secret }, breadcrumbs: [{ message: secret }], transaction: secret, tags: { request_id: requestId, secret },
    contexts: { trace: { trace_id: traceId, span_id: 'd'.repeat(16), data: { secret } }, private: { secret } },
    exception: { values: [{ type: secret, value: secret, stacktrace: { frames: [
      { filename: 'https://' + secret + '/entries/worker/src/index.ts?token=' + secret, lineno: 42, colno: 7, function: secret, vars: { secret }, pre_context: [secret], context_line: secret },
      { filename: '/private/' + secret + '.js', lineno: 1 },
    ] } }] },
  } as unknown as ErrorEvent
  const clean = scrubWorkerEvent(event, { originalException: new Error(secret) })!
  expect(JSON.stringify(clean)).not.toContain(secret)
  expect(clean).not.toHaveProperty('request')
  expect(clean).not.toHaveProperty('breadcrumbs')
  expect(clean.tags).not.toHaveProperty('request_id')
  expect(clean.contexts?.trace?.trace_id).not.toBe(traceId)
  expect(clean.exception?.values?.[0]?.stacktrace?.frames).toEqual([{ filename: 'entries/worker/src/index.ts', lineno: 42, colno: 7, in_app: true }])
  expect(clean).toMatchObject({ release, environment: 'prod', exception: { values: [{ type: 'Error', value: 'eZacto runtime failure' }] } })
})

it('keeps server-generated metadata separate when the same Error is captured concurrently', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const original = new TypeError('SECRET provider token')
  captureWorkerError(original, { phase: 'api', status: 502, requestId, traceId })
  captureWorkerError(original, { phase: 'bootstrap', status: 503, requestId: '22222222-2222-4222-8222-222222222222', traceId: 'd'.repeat(32) })
  expect(captured).toHaveLength(2)
  expect(captured[0]).not.toBe(captured[1])
  const first = scrubWorkerEvent({ release, exception: { values: [{ type: captured[0]!.name, value: original.message }] } }, { originalException: captured[0] })!
  const second = scrubWorkerEvent({ release }, { originalException: captured[1] })!
  expect(first.tags).toMatchObject({ phase: 'api', http_status: '502', request_id: requestId, runtime_trace_id: traceId })
  expect(second.tags).toMatchObject({ phase: 'bootstrap', http_status: '503', request_id: '22222222-2222-4222-8222-222222222222', runtime_trace_id: 'd'.repeat(32) })
  expect(JSON.stringify([first, second])).not.toContain('SECRET')
})

it('ignores expected 4xx and isolates synchronous and asynchronous reporter failures', async () => {
  const capture = vi.mocked(Sentry.captureException).mockReturnValue('e'.repeat(32))
  const expected = new ApiError({ status: 403, code: 'forbidden', message: 'SECRET' })
  captureWorkerError(expected, { phase: 'api', status: 403 })
  expect(scrubWorkerEvent({}, { originalException: expected })).toBeNull()
  expect(capture).not.toHaveBeenCalled()
  const pending: Promise<unknown>[] = []
  expect(() => reportWorkerError(() => { throw new Error('SECRET') }, new Error(), { phase: 'bootstrap' })).not.toThrow()
  expect(() => reportWorkerError(async () => { throw new Error('SECRET') }, new Error(), { phase: 'bootstrap' }, promise => pending.push(promise))).not.toThrow()
  expect(pending).toHaveLength(1)
  await expect(Promise.all(pending)).resolves.toEqual([undefined])
})

it('fails closed on hostile event accessors and discards arbitrary release/environment values', () => {
  const event = Object.defineProperty({}, 'exception', { get: () => { throw new Error('SECRET') } })
  expect(scrubWorkerEvent(event, {})).toBeNull()
  const clean = scrubWorkerEvent({ release: 'SECRET', environment: 'SECRET' }, {})!
  expect(clean.release).toBeUndefined()
  expect(clean.environment).toBe('custom')
  expect(JSON.stringify(clean)).not.toContain('SECRET')
})


it('reads a hostile stack getter once while retaining the static captured failure', () => {
  let reads = 0
  const failure = new Error('SECRET')
  Object.defineProperty(failure, 'stack', { get: () => { reads++; return reads === 1 ? 'Error: SECRET\n at private (script-0:12:9)' : { secret: 'SECRET' } } })
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  expect(() => captureWorkerError(failure, { phase: 'payment', traceId })).not.toThrow()
  expect(reads).toBe(1)
  expect(captured[0]?.message).toBe('eZacto runtime failure')
  const event = scrubWorkerEvent({ exception: { values: [{ value: 'SECRET' }] } }, { originalException: captured[0] })!
  expect(event.tags?.phase).toBe('payment')
  expect(JSON.stringify(event)).not.toContain('SECRET')
})


it('does not suppress a later automatic capture of an Error previously handled by another request', () => {
  vi.mocked(Sentry.captureException).mockReturnValue('e'.repeat(32))
  const shared = new Error('SECRET reused original')
  captureWorkerError(shared, { phase: 'api', requestId, traceId })
  const automatic = scrubWorkerEvent({ exception: { values: [{ value: shared.message }] } }, { originalException: shared })
  expect(automatic).not.toBeNull()
  expect(automatic?.tags?.phase).toBe('uncaught')
  expect(automatic?.tags).not.toHaveProperty('request_id')
  expect(automatic?.tags?.runtime_trace_id).not.toBe(traceId)
  expect(JSON.stringify(automatic)).not.toContain('SECRET')
})


it('does not fabricate a reporter stack when the original stack getter throws', () => {
  const failure = new Error('SECRET')
  Object.defineProperty(failure, 'stack', { get: () => { throw new Error('SECRET getter') } })
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  captureWorkerError(failure, { phase: 'bootstrap', traceId })
  expect(captured[0]?.stack).toBe('')
  const event = scrubWorkerEvent({ exception: { values: [{ stacktrace: { frames: [{ filename: 'entries/worker/src/error-reporting.ts', lineno: 42 }] } }] } }, { originalException: captured[0] })!
  expect(event.tags?.phase).toBe('bootstrap')
  expect(event.exception?.values?.[0]?.stacktrace).toBeUndefined()
})
