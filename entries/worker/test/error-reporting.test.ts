import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import { ApiError } from '@ezacto/api'
import { BillApiError, BillAuthError } from '@ezacto/integrations'
import { captureWorkerError, reportWorkerError, scrubWorkerEvent } from '../src/error-reporting.js'
import type { ErrorEvent } from '@sentry/cloudflare'
import type { WorkerErrorContext } from '../src/error-reporting.js'

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
  expect(clean.exception?.values?.[0]?.stacktrace?.frames).toEqual([{ filename: 'entries/worker/src/index.ts', abs_path: '/entries/worker/src/index.ts', lineno: 42, colno: 7, in_app: true }])
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


it('retains only canonical allowlisted source paths that match uploaded release artifacts', () => {
  const clean = scrubWorkerEvent({ release, exception: { values: [{ stacktrace: { frames: [
    { filename: 'workflow-main.js', abs_path: 'https://SECRET.invalid/private/workflow-main.js?token=SECRET', lineno: 24726, colno: 15 },
    { filename: 'https://SECRET.invalid/not-owned.js', abs_path: '/workflow-main.js', lineno: 1 },
  ] } }] } }, { originalException: new Error('SECRET') })!
  expect(clean.exception?.values?.[0]?.stacktrace?.frames).toEqual([
    { filename: 'workflow-main.js', abs_path: '/workflow-main.js', lineno: 24726, colno: 15, in_app: true },
  ])
  expect(JSON.stringify(clean)).not.toContain('SECRET')
})

it('keeps a static scheduled operation and bounded nested D1 category without private causes', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const original = new Error('Failed query: SELECT SECRET FROM private', { cause: new Error('D1_ERROR: Network connection lost. SECRET') })
  captureWorkerError(original, { phase: 'scheduled', operation: 'QuickBooks catch-up' })
  const clean = scrubWorkerEvent({ release }, { originalException: captured[0] })!
  expect(clean.tags).toMatchObject({ operation: 'QuickBooks catch-up', failure_code: 'd1_network_lost' })
  expect(JSON.stringify(clean)).not.toContain('SECRET')
})

it('rejects arbitrary operation names and bounds cyclic or hostile error causes', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const original = new Error('SECRET')
  Object.defineProperty(original, 'cause', { value: original })
  captureWorkerError(original, { phase: 'scheduled', operation: 'SECRET' } as unknown as WorkerErrorContext)
  const clean = scrubWorkerEvent({}, { originalException: captured[0] })!
  expect(clean.tags).not.toHaveProperty('operation')
  expect(clean.tags?.failure_code).toBe('unknown')
  let reads = 0
  const hostile = Object.defineProperty(new Error('SECRET'), 'cause', { get: () => { reads++; throw new Error('SECRET') } })
  expect(() => captureWorkerError(hostile, { phase: 'scheduled' })).not.toThrow()
  expect(reads).toBe(0)
  expect(JSON.stringify(clean)).not.toContain('SECRET')
})

it('does not classify a user-controlled query parameter as a D1 network cause', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const original = new Error('Failed query: SELECT ? params: D1_ERROR: Network connection lost', { cause: new Error('constraint failed') })
  captureWorkerError(original, { phase: 'scheduled', operation: 'QuickBooks catch-up' })
  const clean = scrubWorkerEvent({}, { originalException: captured[0] })!
  expect(clean.tags?.failure_code).toBe('database_query_failed')
})

it('preserves the initiating stack and classifies retained cleanup causes without private data', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const primary = new Error('SECRET primary')
  primary.stack = 'Error: SECRET primary\n    at refresh (entries/worker/src/index.ts:468:7)'
  const cleanup = new Error('Failed query: SELECT SECRET', { cause: new Error('D1_ERROR: Network connection lost. SECRET') })
  const original = new AggregateError([primary, cleanup], 'SECRET aggregate', { cause: primary })
  captureWorkerError(original, { phase: 'scheduled', operation: 'Deel payment status' })
  expect(captured[0]?.stack).toBe(primary.stack)
  const clean = scrubWorkerEvent({ release, exception: { values: [{ type: 'AggregateError', value: original.message,
    stacktrace: { frames: [{ filename: 'entries/worker/src/index.ts', lineno: 468, colno: 7 }] } }] } }, { originalException: captured[0] })!
  expect(clean.tags).toMatchObject({ failure_code: 'd1_network_lost', operation: 'Deel payment status' })
  expect(clean.exception?.values?.[0]?.stacktrace?.frames).toEqual([
    { filename: 'entries/worker/src/index.ts', abs_path: '/entries/worker/src/index.ts', lineno: 468, colno: 7, in_app: true },
  ])
  expect(JSON.stringify(clean)).not.toContain('SECRET')
  expect(JSON.stringify(clean)).not.toContain('SELECT')
})

it('bounds cyclic aggregate children and never invokes accessors or iterators', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  let reads = 0
  const original = new AggregateError([], 'SECRET')
  const children = [original, new Error('Failed query: SELECT SECRET')]
  Object.defineProperty(children, '2', { get: () => { reads++; throw new Error('SECRET') } })
  Object.defineProperty(children, Symbol.iterator, { get: () => { reads++; throw new Error('SECRET') } })
  Object.defineProperty(original, 'errors', { value: children })
  Object.defineProperty(original, 'cause', { get: () => { reads++; throw new Error('SECRET') } })
  captureWorkerError(original, { phase: 'scheduled' })
  expect(reads).toBe(0)
  const clean = scrubWorkerEvent({}, { originalException: captured[0] })!
  expect(clean.tags?.failure_code).toBe('database_query_failed')
  expect(JSON.stringify(clean)).not.toContain('SECRET')
})

it('does not inspect children beyond the eight-object diagnostic budget', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const original = new AggregateError([
    ...Array.from({ length: 7 }, () => new Error('SECRET')),
    new Error('D1_ERROR: Network connection lost. SECRET'),
  ], 'SECRET')
  captureWorkerError(original, { phase: 'scheduled' })
  expect(scrubWorkerEvent({}, { originalException: captured[0] })!.tags?.failure_code).toBe('unknown')
})

it('tolerates revoked aggregate arrays and hostile errors properties', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  const original = new AggregateError([], 'SECRET')
  Object.defineProperty(original, 'errors', { value: revoked.proxy, configurable: true })
  expect(() => captureWorkerError(original, { phase: 'scheduled' })).not.toThrow()
  let reads = 0
  Object.defineProperty(original, 'errors', { get: () => { reads++; throw new Error('SECRET') } })
  expect(() => captureWorkerError(original, { phase: 'scheduled' })).not.toThrow()
  expect(reads).toBe(0)
  for (const error of captured) expect(JSON.stringify(scrubWorkerEvent({}, { originalException: error }))).not.toContain('SECRET')
})

it('never reads a plain cause or child stack and prefers a nested initiating Error over cleanup', () => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  let reads = 0
  const plain = Object.defineProperty({}, 'stack', { get: () => { reads++; throw new Error('SECRET') } })
  const primary = new Error('SECRET primary')
  primary.stack = 'Error: SECRET primary\n    at origin (entries/worker/src/index.ts:468:7)'
  const nested = new AggregateError([plain, primary], 'SECRET nested', { cause: plain })
  const cleanup = new Error('SECRET cleanup')
  cleanup.stack = 'Error: SECRET cleanup\n    at cleanup (entries/worker/src/index.ts:496:7)'
  captureWorkerError(new AggregateError([nested, cleanup], 'SECRET outer', { cause: nested }), { phase: 'scheduled' })
  expect(reads).toBe(0)
  expect(captured[0]?.stack).toBe(primary.stack)
  expect(JSON.stringify(scrubWorkerEvent({}, { originalException: captured[0] }))).not.toContain('SECRET')
})

it.each([
  ['D1_ERROR: D1 DB is overloaded. Requests queued for too long.', 'd1_overloaded'],
  ['D1_ERROR: D1 DB is overloaded. Too many requests queued.', 'd1_overloaded'],
  ['D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.', 'd1_timeout'],
  ["D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset.", 'd1_resource_limit'],
  ['D1_ERROR: D1 DB exceeded its CPU time limit and was reset.', 'd1_resource_limit'],
  ['D1_ERROR: D1 query result exceeded the maximum response size limit of 50 MB', 'd1_resource_limit'],
  ['Too many API requests by single Worker invocation', 'worker_request_limit'],
])('keeps a static category for %s through query and aggregate wrappers', (message, code) => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  const cause = new Error(message + ' SECRET')
  const query = new Error('Failed query: SELECT SECRET params: SECRET', { cause })
  captureWorkerError(new AggregateError([query], 'SECRET', { cause: query }), { phase: 'scheduled', operation: 'demo maintenance' })
  const clean = scrubWorkerEvent({}, { originalException: captured[0] })!
  expect(clean.tags?.failure_code).toBe(code)
  expect(JSON.stringify(clean)).not.toContain('SECRET')
  expect(JSON.stringify(clean)).not.toContain('SELECT')
  expect(scrubWorkerEvent({}, { originalException: cause })!.tags?.failure_code).toBe(code)
  expect(scrubWorkerEvent({}, { originalException: new Error('Failed query: SELECT ? params: ' + message) })!.tags?.failure_code).toBe('database_query_failed')
})


it('classifies the observed readiness exec overload without parsing arbitrary SQL', () => {
  const platform = 'D1 DB is overloaded. Too many resources consumed within a 10 second window'
  for (const pragma of ['PRAGMA foreign_keys = ON', 'PRAGMA foreign_keys=ON']) {
    const message = `D1_EXEC_ERROR: Error in line 1: ${pragma}: ${platform}`
    const error = new Error(message, { cause: new Error(message.slice('D1_EXEC_ERROR: '.length)) })
    const clean = scrubWorkerEvent({}, { originalException: error })!
    expect(clean.tags?.failure_code).toBe('d1_overloaded')
    expect(JSON.stringify(clean)).not.toContain('PRAGMA')
    expect(JSON.stringify(clean)).not.toContain('resources consumed')
  }
  const query = new Error(`D1_EXEC_ERROR: Error in line 1: SELECT '${platform}': syntax error`)
  expect(scrubWorkerEvent({}, { originalException: query })!.tags?.failure_code).toBe('unknown')
})

it.each([
  [new BillApiError(401, 'PRIVATE_CODE', 'PRIVATE_PROVIDER_BODY'), 'bill_http_401'],
  [new BillApiError(403, 'PRIVATE_CODE', 'PRIVATE_PROVIDER_BODY'), 'bill_http_403'],
  [new BillApiError(429, 'PRIVATE_CODE', 'PRIVATE_PROVIDER_BODY'), 'bill_http_429'],
  [new BillApiError(422, 'PRIVATE_CODE', 'PRIVATE_PROVIDER_BODY'), 'bill_http_4xx'],
  [new BillApiError(503, 'PRIVATE_CODE', 'PRIVATE_PROVIDER_BODY'), 'bill_http_5xx'],
  [new BillAuthError(401, 'PRIVATE_PROVIDER_BODY'), 'bill_http_401'],
] as const)('reports only the bounded BILL response category for scheduled reconciliation', (original, expected) => {
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  captureWorkerError(original, { phase: 'scheduled', operation: 'BILL reconciliation' })
  const clean = scrubWorkerEvent({}, { originalException: captured[0] })!
  expect(clean.tags?.failure_code).toBe(expected)
  expect(JSON.stringify(clean)).not.toContain('PRIVATE_')
  captureWorkerError(original, { phase: 'scheduled', operation: 'QuickBooks catch-up' })
  const other = scrubWorkerEvent({}, { originalException: captured[1] })!
  expect(other.tags?.failure_code).toBe('unknown')
})

it('does not trust an untyped error or getter as a BILL status', () => {
  const fake = new Error('PRIVATE_')
  let reads = 0
  Object.defineProperty(fake, 'status', { get: () => { reads++; return 401 } })
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  captureWorkerError(fake, { phase: 'scheduled', operation: 'BILL reconciliation' })
  expect(scrubWorkerEvent({}, { originalException: captured[0] })!.tags?.failure_code).toBe('unknown')
  expect(reads).toBe(0)
})

it('ignores hostile nested prototypes without losing the scheduled report', () => {
  const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('PRIVATE_') } })
  const original = new Error('PRIVATE_', { cause: hostile })
  const captured: Error[] = []
  vi.mocked(Sentry.captureException).mockImplementation(error => { captured.push(error as Error); return 'e'.repeat(32) })
  expect(() => captureWorkerError(original, { phase: 'scheduled', operation: 'BILL reconciliation' })).not.toThrow()
  expect(scrubWorkerEvent({}, { originalException: captured[0] })!.tags?.failure_code).toBe('unknown')
})
