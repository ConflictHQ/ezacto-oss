import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  createD1Database, createD1SessionStore, createManagedQuickBooksGrantStore,
  createQuickBooksStore, createQuickBooksMirrorSource, createQuickBooksReconciliationSource,
  migrateD1, createManagedQuickBooksRefreshStore,
} from '@ezacto/db/d1'
import { createApiSessionService, createManagedQuickBooksGrantCommands } from '@ezacto/api'
import { createQuickBooksRuntime, createManagedQuickBooksRefresh, type QuickBooksRuntime } from '@ezacto/integrations'
import { createRuntimeServices } from '../src/runtime.js'
import { createApp, type WorkerEnv } from '../src/app.js'
import { managedQuickBooksAvailable, type WorkerManagedQuickBooks } from '../src/managed-providers.js'

const at = new Date().toISOString()
const cursor = 'A'.repeat(43)
const miniflares: Miniflare[] = []
let fixtureRoot: string | undefined
let server: Server
let providerOrigin: string
const calls: string[] = []
const refreshCalls: string[] = []
const accessTokens = new Map<string, string>()
let onRefresh: (() => Promise<void>) | undefined
let loseRefreshReply = false
const tenants: { database: D1Database; cookie: string; member: string; realm: string; origin: string }[] = []
const scopes = new WeakMap<object, (typeof tenants)[number]>()
const runtimes = new WeakMap<object, QuickBooksRuntime>()
const compose = vi.fn(async ({ scope, database }: Parameters<WorkerManagedQuickBooks['compose']>[0]) => {
  const tenant = scopes.get(scope)
  if (!tenant) throw new Error('Unrecognized trusted tenant scope')
  const db = createD1Database(database)
  const runtime = createQuickBooksRuntime({
    config: { clientId: 'shared-platform-app-id', clientSecret: 'PRIVATE_PLATFORM_SECRET', webhookVerifierToken: undefined, appBaseUrl: tenant.origin, environment: 'sandbox' },
    managedRefresh: createManagedQuickBooksRefresh({ store: createManagedQuickBooksRefreshStore(db), admitted: () => scopes.has(scope), now: () => new Date() }),
    store: createQuickBooksStore(db), source: createQuickBooksMirrorSource(db, () => new Date()),
    reconciliation: createQuickBooksReconciliationSource(db), now: () => new Date(),
    fetch: request => {
      // A genuine local HTTP transport, with the native parser and authorization.
      const url = new URL(request.url)
      return fetch(new URL(url.pathname + url.search, providerOrigin), request)
    },
  })
  runtimes.set(scope, runtime)
  return runtime
})
const port: WorkerManagedQuickBooks = { configured: scope => scopes.has(scope), compose }
const environment = (tenant: (typeof tenants)[number], extra: Partial<WorkerEnv> = {}): WorkerEnv => ({
  DB: tenant.database, API_CURSOR_SIGNING_KEY: cursor, ENVIRONMENT: 'test', RELEASE: 'managed-runtime-fixture',
  APP_BASE_URL: tenant.origin,
  // An explicit managed option must never select this unrelated environment app.
  QUICKBOOKS_CLIENT_ID: 'foreign-environment-app', QUICKBOOKS_CLIENT_SECRET: 'PRIVATE_FOREIGN_SECRET',
  ...extra,
})

beforeAll(async () => {
  server = createServer((request, response) => { void (async () => {
    if (request.method === 'POST' && request.url === '/oauth2/v1/tokens/bearer') {
      if (request.headers.authorization !== `Basic ${Buffer.from('shared-platform-app-id:PRIVATE_PLATFORM_SECRET').toString('base64')}`) {
        response.writeHead(403); response.end('{}'); return
      }
      let body = ''
      for await (const part of request) body += String(part)
      const realm = /^PRIVATE_REFRESH_(111|222)$/.exec(new URLSearchParams(body).get('refresh_token') ?? '')?.[1]
      if (!realm) { response.writeHead(403); response.end('{}'); return }
      refreshCalls.push(realm)
      await onRefresh?.()
      const access = `PRIVATE_ROTATED_ACCESS_${realm}`
      accessTokens.set(realm, access)
      if (loseRefreshReply) { loseRefreshReply = false; response.destroy(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ access_token: access, refresh_token: `PRIVATE_ROTATED_REFRESH_${realm}`,
        token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 86400 }))
      return
    }
    const realm = /\/v3\/company\/(\d+)\/query/u.exec(request.url ?? '')?.[1]
    if (request.method !== 'GET' || !realm || request.headers.authorization !== `Bearer ${accessTokens.get(realm) ?? `PRIVATE_ACCESS_${realm}`}`) {
      response.writeHead(403); response.end('{}'); return
    }
    calls.push(realm)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ QueryResponse: { Invoice: [] } }))
  })().catch(() => { response.writeHead(500); response.end('{}') }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Local provider did not bind')
  providerOrigin = `http://127.0.0.1:${address.port}`
  fixtureRoot = await mkdtemp(join(tmpdir(), 'ezacto-managed-runtime-'))
  const options = { modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] } as const
  const templatePath = join(fixtureRoot, 'template')
  const template = new Miniflare({ ...options, d1Persist: templatePath })
  miniflares.push(template)
  await migrateD1(await template.getD1Database('DB'))
  // Only a closed, empty migrated database is shared. Each tenant below owns
  // its physical snapshot, workerd, users, sessions, grants and connection.
  await template.dispose()
  miniflares.splice(miniflares.indexOf(template), 1)
  for (const [index, name] of ['ONE', 'TWO'].entries()) {
    const path = join(fixtureRoot, name)
    await cp(templatePath, path, { recursive: true })
    const miniflare = new Miniflare({ ...options, d1Persist: path })
    miniflares.push(miniflare)
    const database = await miniflare.getD1Database('DB')
    await database.batch([
      database.prepare("INSERT INTO organizations(name,modules,created_at,updated_at) VALUES(?,'{}',?,?)").bind(name, at, at),
      database.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owner','Fixture','administrator','[]',?,?),(2,'Admin','Fixture','administrator','[]',?,?),(3,'Member','Fixture','member','[]',?,?)").bind(at,at,at,at,at,at),
    ])
    const sessions = createD1SessionStore(database)
    const admin = await sessions.issue(2), member = await sessions.issue(3)
    const realm = String((index + 1) * 111), origin = `https://${name.toLowerCase()}.native.test`
    const tenant = { database, realm, origin, cookie: `__Host-ezacto_session=${admin.token}`, member: `__Host-ezacto_session=${member.token}` }
    const commands = createManagedQuickBooksGrantCommands({
      store: createManagedQuickBooksGrantStore(createD1Database(database)),
      authentication: { sessions: createApiSessionService(sessions) }, now: () => at,
    })
    const accepted = await commands.accept(new Request(`${origin}/_hosted/quickbooks/redeem`, {
      method: 'POST', headers: { cookie: tenant.cookie, origin },
    }), {
      grantId: String(index + 1).repeat(64), browserHash: 'b'.repeat(64), credentialHash: 'c'.repeat(64),
      expectedActorUserId: 2, expectedConnectionGeneration: 0, expiresAt: Date.parse(at) + 600_000,
      tokens: { realmId: realm, companyName: name, accessToken: `PRIVATE_ACCESS_${realm}`, refreshToken: `PRIVATE_REFRESH_${realm}`,
        accessTokenExpiresAt: new Date(Date.parse(at) + 3600_000).toISOString(), refreshTokenExpiresAt: new Date(Date.parse(at) + 86400_000).toISOString(), scope: 'com.intuit.quickbooks.accounting' },
    })
    if (accepted instanceof Response) throw new Error(`Native grant refused with ${accepted.status}`)
    expect(accepted.outcome).toBe('accepted')
    tenants.push(tenant); scopes.set(database, tenant)
  }
}, 120_000)
afterAll(async () => {
  const results = await Promise.allSettled(miniflares.splice(0).map(miniflare => miniflare.dispose()))
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } finally {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  }
  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Managed runtime fixture disposal failed')
})

it('[integration #1235] composes the accepted native grant into authorized tenant-specific status and read-only reconciliation', async () => {
  for (const tenant of tenants) {
    const env = environment(tenant)
    const services = await createRuntimeServices(env, { managedQuickBooks: port })
    expect(services.quickBooks).toBe(runtimes.get(tenant.database)!.service)
    expect(services.quickBooks!.clientId()).toBe('shared-platform-app-id')
    const app = createApp(services)
    const before = calls.length
    const status = await app.fetch(new Request(`${tenant.origin}/api/v1/integrations/quickbooks`, { headers: { cookie: tenant.cookie } }), env)
    expect(status.status).toBe(200)
    const text = await status.text()
    expect(JSON.parse(text)).toMatchObject({ data: { configured: true, connection: { realm_id: tenant.realm } } })
    expect(text).not.toContain('PRIVATE_')
    expect(calls).toHaveLength(before)
    const denied = await app.fetch(new Request(`${tenant.origin}/api/v1/integrations/quickbooks/reconciliation`, { headers: { cookie: tenant.member } }), env)
    expect(denied.status).toBe(403)
    expect(calls).toHaveLength(before)
    const report = await app.fetch(new Request(`${tenant.origin}/api/v1/integrations/quickbooks/reconciliation`, { headers: { cookie: tenant.cookie } }), env)
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({ data: { realm_id: tenant.realm, rows: [] } })
    expect(calls.slice(before)).toEqual([tenant.realm])
    expect(await tenant.database.prepare('SELECT count(*) AS count FROM invoices').first()).toEqual({ count: 0 })
    expect(await tenant.database.prepare('SELECT count(*) AS count FROM invoice_payments').first()).toEqual({ count: 0 })
  }
})

it('[integration #1235] owns one real HTTP refresh across competing Worker runtimes and a fresh restart', async () => {
  const tenant = tenants[0]!, env = environment(tenant)
  await tenant.database.prepare('UPDATE quickbooks_connections SET access_token_expires_at=? WHERE id=1')
    .bind(new Date(Date.now() - 60_000).toISOString()).run()
  const generation = await tenant.database.prepare('SELECT generation FROM quickbooks_connection_generation').first()
  const before = refreshCalls.length
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  onRefresh = async () => { entered(); await released }
  const first = createApp(await createRuntimeServices(env, { managedQuickBooks: port }))
  const second = createApp(await createRuntimeServices(env, { managedQuickBooks: port }))
  const request = () => new Request(`${tenant.origin}/api/v1/integrations/quickbooks/reconciliation`, { headers: { cookie: tenant.cookie } })
  const result = first.fetch(request(), env)
  try {
    await started
    const pending = await second.fetch(new Request(`${tenant.origin}/api/v1/integrations/quickbooks`, { headers: { cookie: tenant.cookie } }), env)
    expect(await pending.json()).toMatchObject({ data: { authorization: 'pending' } })
    const refused = await second.fetch(request(), env)
    expect(refused.status).toBe(409)
    expect(await refused.text()).not.toContain('PRIVATE_')
    expect(refreshCalls.length).toBe(before + 1)
  } finally { release(); onRefresh = undefined }
  expect((await result).status).toBe(200)
  const restarted = createApp(await createRuntimeServices(env, { managedQuickBooks: port }))
  expect((await restarted.fetch(request(), env)).status).toBe(200)
  expect(refreshCalls.length).toBe(before + 1)
  expect(await tenant.database.prepare('SELECT generation FROM quickbooks_connection_generation').first()).toEqual(generation)
  expect(await tenant.database.prepare('SELECT count(*) AS n FROM invoices').first()).toEqual({ n: 0 })
  const status = await restarted.fetch(new Request(`${tenant.origin}/api/v1/integrations/quickbooks`, { headers: { cookie: tenant.cookie } }), env)
  const text = await status.text()
  expect(JSON.parse(text)).toMatchObject({ data: { authorization: 'ready', connection: { realm_id: tenant.realm } } })
  expect(text).not.toContain('PRIVATE_')
})

it('[integration #1235] retains a real HTTP lost-refresh outcome across Worker restart without repeating transport', async () => {
  const tenant = tenants[1]!, env = environment(tenant)
  await tenant.database.prepare('UPDATE quickbooks_connections SET access_token_expires_at=? WHERE id=1')
    .bind(new Date(Date.now() - 60_000).toISOString()).run()
  const before = refreshCalls.length, readBefore = calls.length
  loseRefreshReply = true
  const request = () => new Request(`${tenant.origin}/api/v1/integrations/quickbooks/reconciliation`, { headers: { cookie: tenant.cookie } })
  const first = createApp(await createRuntimeServices(env, { managedQuickBooks: port }))
  const response = await first.fetch(request(), env)
  expect(response.status).toBe(409)
  expect(await response.text()).not.toContain('PRIVATE_')
  expect(refreshCalls.length).toBe(before + 1)
  const restarted = createApp(await createRuntimeServices(env, { managedQuickBooks: port }))
  const status = await restarted.fetch(new Request(`${tenant.origin}/api/v1/integrations/quickbooks`, { headers: { cookie: tenant.cookie } }), env)
  const body = await status.text()
  expect(JSON.parse(body)).toMatchObject({ data: { authorization: 'unavailable', connection: { realm_id: tenant.realm } } })
  expect(body).not.toContain('PRIVATE_')
  expect((await restarted.fetch(request(), env)).status).toBe(409)
  expect(refreshCalls.length).toBe(before + 1)
  expect(calls.length).toBe(readBefore)
  expect(await tenant.database.prepare('SELECT status FROM quickbooks_refresh_attempts').first()).toEqual({ status: 'unknown' })
})

it('[integration #1235] explicit unavailable composition never falls back to the environment app', async () => {
  const tenant = tenants[0]!
  const unavailable = { configured: () => true, compose: vi.fn(async () => null) }
  const services = await createRuntimeServices(environment(tenant), { managedQuickBooks: unavailable })
  expect(unavailable.compose).toHaveBeenCalledTimes(1)
  expect(services.quickBooks).toBeUndefined()
  const legacy = await createRuntimeServices(environment(tenant))
  expect(legacy.quickBooks!.clientId()).toBe('foreign-environment-app')
})

it.each([
  { ACCOUNTING_ENABLED: 'false' },
  { DEMO_MODE: 'true', ENVIRONMENT: 'dev' },
])('[security #1235] never invokes a managed provider when deployment policy excludes it: %j', async extra => {
  const tenant = tenants[0]!, before = compose.mock.calls.length
  const services = await createRuntimeServices(environment(tenant, extra), { managedQuickBooks: port })
  expect(services.quickBooks).toBeUndefined()
  expect(compose.mock.calls.length).toBe(before)
})

it('[integration #1235] the service-free shell uses trusted availability without composing or probing a provider', async () => {
  const tenant = tenants[0]!, env = environment(tenant)
  delete env.QUICKBOOKS_CLIENT_ID
  delete env.QUICKBOOKS_CLIENT_SECRET
  const before = compose.mock.calls.length
  const app = createApp(undefined, undefined, undefined, undefined, undefined, {
    quickBooks: () => managedQuickBooksAvailable(port, env, tenant.database),
  })
  const response = await app.fetch(new Request(`${tenant.origin}/invoices`), env)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('data-accounting-provider="quickbooks" data-provider-available="true"')
  expect(compose.mock.calls.length).toBe(before)
})
