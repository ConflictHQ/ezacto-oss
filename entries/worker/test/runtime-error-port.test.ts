import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@ezacto/api'
import * as Sentry from '@sentry/cloudflare'
import { createWorker } from '../src/index.js'
import { createApp } from '../src/app.js'
import { createRuntimeServices, ensureRuntimeDatabaseReady } from '../src/runtime.js'
import type { WorkerEnv } from '../src/app.js'
import type { WorkerErrorContext } from '../src/error-reporting.js'

const fixture = vi.hoisted(() => ({ failures: new Map<string, Error>(), gates: new Map<string, Promise<void>>() }))
vi.mock('../src/runtime.js', async original => ({ ...(await original<object>()), createRuntimeServices: vi.fn(), ensureRuntimeDatabaseReady: vi.fn() }))
vi.mock('@sentry/cloudflare', async original => ({ ...(await original<object>()), captureException: vi.fn(), withSentry: (_options: unknown, handler: unknown) => handler }))
vi.mock('../src/app.js', async original => {
  const actual = await original<typeof import('../src/app.js')>()
  return { ...actual, createApp: vi.fn((...args: Parameters<typeof actual.createApp>) => {
    const app = actual.createApp(...args)
    app.get('/owned-error', async context => {
      const key = new URL(context.req.url).searchParams.get('case') ?? ''
      await fixture.gates.get(key)
      throw fixture.failures.get(key) ?? new Error('SECRET default failure')
    })
    return app
  }) }
})
beforeEach(() => { vi.clearAllMocks(); fixture.failures.clear(); fixture.gates.clear() })
const context = () => {
  const pending: Promise<unknown>[] = []
  return { pending, ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext }
}
const incoming = (url: string, init?: RequestInit): Request<unknown, IncomingRequestCfProperties> => new Request(url, init) as Request<unknown, IncomingRequestCfProperties>
const env = { ENVIRONMENT: 'test', RELEASE: 'a'.repeat(40) } as WorkerEnv

it('reports the silent bootstrap 503 with its exact server request ID and original error', async () => {
  const failure = new TypeError('SECRET binding SQL provider value')
  vi.mocked(createRuntimeServices).mockRejectedValue(failure)
  const reports: { error: Error; context: WorkerErrorContext }[] = []
  const worker = createWorker({ reportError: (error, context) => { reports.push({ error, context }) } })
  const { ctx } = context()
  const response = await worker.fetch!(incoming('https://fixture.invalid/api/v1/profile', { headers: { 'x-request-id': 'attacker', 'sentry-trace': 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-1' } }), env, ctx)
  expect(response.status).toBe(503)
  const body = await response.json() as { request_id: string }
  expect(response.headers.get('x-request-id')).toBe(body.request_id)
  expect(reports).toHaveLength(1)
  expect(reports[0]!.error).toBe(failure)
  expect(reports[0]!.context).toMatchObject({ phase: 'bootstrap', status: 503, requestId: body.request_id })
  expect(reports[0]!.context.traceId).toMatch(/^[a-f0-9]{32}$/)
  expect(reports[0]!.context.traceId).not.toBe('a'.repeat(32))
  expect(Sentry.captureException).not.toHaveBeenCalled()
})

it('caches the public app while concurrent API errors retain their own request/trace context', async () => {
  let release!: () => void
  fixture.gates.set('first', new Promise<void>(resolve => { release = resolve }))
  const firstError = new ApiError({ status: 502, code: 'provider_error', message: 'SECRET first' })
  const secondError = new ApiError({ status: 500, code: 'internal_error', message: 'SECRET second' })
  fixture.failures.set('first', firstError); fixture.failures.set('second', secondError)
  const reports: { error: Error; context: WorkerErrorContext }[] = []
  const worker = createWorker({ reportError: (error, context) => { reports.push({ error, context }) } })
  const first = worker.fetch!(incoming('https://fixture.invalid/owned-error?case=first'), env, context().ctx)
  const second = await worker.fetch!(incoming('https://fixture.invalid/owned-error?case=second'), env, context().ctx)
  release(); const original = await first
  const secondBody = await second.json() as { request_id: string }
  const firstBody = await original.json() as { request_id: string }
  expect(original.status).toBe(502); expect(second.status).toBe(500)
  expect(createApp).toHaveBeenCalledTimes(1)
  expect(reports.map(item => item.error)).toEqual([secondError, firstError])
  expect(reports.map(item => item.context.requestId)).toEqual([secondBody.request_id, firstBody.request_id])
  expect(new Set(reports.map(item => item.context.traceId)).size).toBe(2)
  expect(reports.map(item => item.context.phase)).toEqual(['api', 'api'])
})

it.each(['throw', 'reject'] as const)('keeps readiness and bootstrap responses unchanged when a reporter will %s', async mode => {
  const failure = new Error('SECRET readiness')
  vi.mocked(ensureRuntimeDatabaseReady).mockRejectedValue(failure)
  vi.mocked(createRuntimeServices).mockRejectedValue(failure)
  const worker = createWorker({ reportError: () => { if (mode === 'throw') throw new Error('sink failed'); return Promise.reject(new Error('sink rejected')) } })
  const { ctx, pending } = context()
  const ready = await worker.fetch!(incoming('https://fixture.invalid/readyz'), env, ctx)
  expect(ready.status).toBe(503); expect(await ready.json()).toEqual({ status: 'unavailable' })
  const bootstrap = await worker.fetch!(incoming('https://fixture.invalid/api/v1/profile'), env, ctx)
  expect(bootstrap.status).toBe(503)
  expect(await bootstrap.text()).not.toContain('SECRET')
  expect(pending).toHaveLength(mode === 'reject' ? 2 : 0)
  await expect(Promise.all(pending)).resolves.toBeDefined()
})

it('does not report expected 4xx API errors and observes asynchronous API-port rejection', async () => {
  const report = vi.fn(async () => { throw new Error('SECRET sink') })
  const worker = createWorker({ reportError: report })
  const { ctx, pending } = context()
  fixture.failures.set('expected', new ApiError({ status: 403, code: 'forbidden', message: 'Expected refusal' }))
  expect((await worker.fetch!(incoming('https://fixture.invalid/owned-error?case=expected'), env, ctx)).status).toBe(403)
  expect(report).not.toHaveBeenCalled()
  expect((await worker.fetch!(incoming('https://fixture.invalid/owned-error?case=unexpected'), env, ctx)).status).toBe(500)
  expect(report).toHaveBeenCalledTimes(1)
  expect(pending).toHaveLength(1)
  await expect(Promise.all(pending)).resolves.toEqual([undefined])
})
