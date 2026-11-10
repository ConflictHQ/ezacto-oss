import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { createD1Database, createD1SessionStore, createManagedDeelConnectionStore,
  createDeelCredentialSource, createDeelSyncStore, createDeelSyncSettingsStore, migrateD1 } from '@ezacto/db/d1'
import { createApiSessionService, createManagedDeelConnectionCommands } from '@ezacto/api'
import { createManagedDeelSyncRuntime } from '@ezacto/integrations'
import { createWorker } from '../src/index.js'
import { createRuntimeServices } from '../src/runtime.js'
import type { WorkerManagedDeel } from '../src/managed-providers.js'
import type { WorkerEnv } from '../src/app.js'

const at = new Date().toISOString(), window = { from: '2026-10-01', to: '2026-10-02' }
const workers: Miniflare[] = []
let root: string, server: Server, origin: string, closed = false
const tokens = new Set<string>(), calls: { token: string; method: string }[] = []
const tenants: { binding: D1Database; cookie: string; member: string; token: string; enabled: boolean }[] = []
const scopes = new WeakMap<object, (typeof tenants)[number]>()
const compose = vi.fn(async ({ scope, database }: Parameters<WorkerManagedDeel['compose']>[0]) => {
  const tenant = scopes.get(scope)
  if (!tenant) throw new Error('Unknown trusted tenant scope')
  const db = createD1Database(database), credentials = createDeelCredentialSource(db)
  return createManagedDeelSyncRuntime({
    credentials: {
      current: () => tenant.enabled ? credentials.current() : Promise.resolve(null),
      generation: async () => tenant.enabled ? credentials.generation() : -1,
    },
    source: createDeelSyncStore(db), settings: createDeelSyncSettingsStore(db),
    baseUrl: origin, now: () => new Date(),
    fetch: request => {
      if (new URL(request.url).origin !== origin) throw new Error('Non-local provider refused')
      return fetch(request)
    },
  })
})
const port: WorkerManagedDeel = { configured: scope => scopes.get(scope)?.enabled === true, compose }
const environment = (tenant: (typeof tenants)[number]): WorkerEnv => ({
  DB: tenant.binding, ENVIRONMENT: 'test', RELEASE: 'a'.repeat(40),
  API_CURSOR_SIGNING_KEY: 'A'.repeat(43), APP_BASE_URL: 'https://owned.example',
  DEEL_TOKEN: 'PRIVATE_FOREIGN_DEPLOYMENT', DEEL_SYNC_START_DATE: '2026-01-01',
})
const request = (path: string, cookie: string, method = 'GET', body?: unknown) => new Request(
  'https://owned.example/api/v1/deel-sync' + path, {
    method, headers: { cookie, origin: 'https://owned.example', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  },
) as Request<unknown, IncomingRequestCfProperties>
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-deel-worker-'))
  const options = { modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] } as const
  const templatePath = join(root, 'template'), template = new Miniflare({ ...options, d1Persist: templatePath })
  workers.push(template)
  await migrateD1(await template.getD1Database('DB'))
  await template.dispose(); workers.splice(workers.indexOf(template), 1)
  if (closed) throw new Error('Fixture setup was closed')
  server = createServer((incoming, response) => {
    const token = incoming.headers.authorization ?? ''
    if (!tokens.has(token) || incoming.method !== 'GET') { response.writeHead(403); response.end('{}'); return }
    calls.push({ token, method: incoming.method })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [], page: { limit: 100, offset: 0, total_rows: 0 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned provider did not bind')
  origin = `http://127.0.0.1:${address.port}`
  for (const name of ['A', 'B']) {
    if (closed) throw new Error('Fixture setup was closed')
    const path = join(root, name); await cp(templatePath, path, { recursive: true })
    const worker = new Miniflare({ ...options, d1Persist: path }); workers.push(worker)
    const binding = await worker.getD1Database('DB')
    await binding.batch([
      binding.prepare("INSERT INTO organizations(name,modules,created_at,updated_at) VALUES(?,'{}',?,?)").bind(name, at, at),
      binding.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owner','Fixture','administrator','[]',?,?),(2,'Member','Fixture','member','[]',?,?)").bind(at,at,at,at),
    ])
    const sessions = createD1SessionStore(binding), admin = await sessions.issue(1), member = await sessions.issue(2)
    const cookie = `__Host-ezacto_session=${admin.token}`, token = `PRIVATE_TENANT_${name}`
    const commands = createManagedDeelConnectionCommands({
      store: createManagedDeelConnectionStore(createD1Database(binding)),
      authentication: { sessions: createApiSessionService(sessions) }, now: () => at,
    })
    const connected = await commands.connect(request('', cookie, 'POST'), {
      expectedActorUserId: 1, expectedGeneration: 0, token, startDate: window.from,
    })
    if (connected instanceof Response) throw new Error(`Native connection refused ${connected.status}`)
    expect(connected.generation).toBe(1)
    const tenant = { binding, cookie, member: `__Host-ezacto_session=${member.token}`, token, enabled: true }
    tenants.push(tenant); scopes.set(binding, tenant); tokens.add('Bearer ' + token)
  }
}, 120_000)
afterAll(async () => {
  closed = true
  const results = await Promise.allSettled(workers.splice(0).map(worker => worker.dispose()))
  try {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      }))
    }
  } finally { if (root) await rm(root, { recursive: true, force: true }) }
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Fixture cleanup failed')
})

it.each([0, 1])('[integration #1238] native Worker tenant %s consumes managed status/preview without shared-token or auxiliary capability fallback', async index => {
  const tenant = tenants[index]!, env = environment(tenant), worker = createWorker({ managedDeel: port })
  const before = calls.length
  const denied = await worker.fetch!(request('/preview', tenant.member, 'POST', window), env, context)
  expect(denied.status).toBe(403); expect(calls).toHaveLength(before)
  const status = await worker.fetch!(request('', tenant.cookie), env, context)
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ configured: true, mode: 'manual' })
  expect(calls).toHaveLength(before)
  const preview = await worker.fetch!(request('/preview', tenant.cookie, 'POST', window), env, context)
  expect(preview.status).toBe(200)
  const text = await preview.text()
  expect(JSON.parse(text)).toMatchObject({ status: 'ready', entry_ids: [], timesheets: 0 })
  expect(text).not.toMatch(/PRIVATE_|Bearer/)
  expect(calls.length).toBeGreaterThan(before)
  expect(calls.slice(before).every(call => call.token === 'Bearer ' + tenant.token && call.method === 'GET')).toBe(true)
  const services = await createRuntimeServices(env, { managedDeel: port })
  expect(services.deelStaging!.configured).toBe(false)
  expect(await services.deelPaymentStatus!.refresh(null)).toMatchObject({ configured: false })
  const absent = { configured: () => true, compose: vi.fn(async () => null) }
  const unavailable = await createRuntimeServices(env, { managedDeel: absent })
  expect(unavailable.deelSync).toBeUndefined()
  expect(unavailable.deelStaging!.configured).toBe(false)
  expect(await unavailable.deelPaymentStatus!.refresh(null)).toMatchObject({ configured: false })
  for (const extra of [{ DEMO_MODE: 'true', ENVIRONMENT: 'dev' }, { ACCOUNTING_ENABLED: 'false' }]) {
    const count = compose.mock.calls.length
    expect((await createRuntimeServices({ ...env, ...extra }, { managedDeel: port })).deelSync).toBeUndefined()
    expect(compose.mock.calls.length).toBe(count)
  }
  tenant.enabled = false
  const exchanges = calls.length
  expect((await createRuntimeServices(env, { managedDeel: port })).deelSync).toBeUndefined()
  expect(await services.deelSync!.preview(window)).toMatchObject({ status: 'unconfigured' })
  expect(calls).toHaveLength(exchanges)
})
