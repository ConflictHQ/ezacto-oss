import { copyFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import { createContainerDatabase, createD1Database } from '../../src/adapters.js'
import { migrateContainer, migrateD1 } from '../../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../../src/sessions.js'
import { createManagedWiseConnectionStore } from '../../src/managed-wise.js'
import { createPayoutAccountStore } from '../../src/payout-accounts.js'
import { createApiSessionService } from '../../../api/src/sessions.js'
import { createManagedWiseConnectionCommands } from '../../../api/src/index.js'
import { createManagedWiseRuntime } from '../../../integrations/src/wise/managed.js'
import { createManagedWiseVault } from '@ezacto/core'

export const initial = '2026-10-24T18:00:00.000Z'
export const key = (n: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(n)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
const worker = {
  modules: true,
  script: 'export default {fetch(){return new Response("ok")}}',
  d1Databases: ['DB'],
} as const
let templates: { root: string; sqlite: string; d1: string }
let server: Server, providerOrigin: string
let templateWorker: Miniflare | undefined
let setupClosed = false
export const credentials = new Map<string, string>()
export const calls: { profile: string; path: string; method: string }[] = []
export const providerState: { beforeResponse: (() => Promise<void>) | undefined; failure: boolean } = { beforeResponse: undefined, failure: false }
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wise-templates-'))
  templates = { root, sqlite: join(root, 'empty.sqlite'), d1: join(root, 'd1') }
  const native = new BetterSqlite3(templates.sqlite)
  try {
    migrateContainer(native)
  } finally {
    native.close()
  }
  const mf = new Miniflare({ ...worker, d1Persist: templates.d1 })
  templateWorker = mf
  try {
    await migrateD1(await mf.getD1Database('DB'))
  } finally {
    await mf.dispose()
    templateWorker = undefined
  }
  if (setupClosed) throw new Error('Wise fixture setup was closed')
  server = createServer((request, response) => {
    void (async () => {
      const profile = credentials.get(request.headers.authorization ?? '')
      const path = request.url ?? ''
      if (!profile || request.method !== 'GET') {
        response.writeHead(403)
        response.end('{}')
        return
      }
      calls.push({ profile, path, method: request.method })
      const run = providerState.beforeResponse
      providerState.beforeResponse = undefined
      await run?.()
      if (providerState.failure) {
        response.writeHead(401)
        response.end('{"secret":"PRIVATE_PROVIDER_DETAIL"}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      if (path === '/v2/profiles') {
        response.end(
          JSON.stringify([{ id: profile, type: 'BUSINESS', fullName: `Owned ${profile}` }]),
        )
      } else if (path === `/v2/accounts?profileId=${profile}`) {
        response.end(
          JSON.stringify([
            {
              id: '9007199254740993123',
              accountHolderName: 'Owned recipient',
              currency: 'USD',
              type: 'Aba',
              accountSummary: '123456789012345',
              details: { accountNumber: '123456789012345' },
              longAccountSummary: 'ending in 2345',
              active: true,
              ownedByCustomer: false,
            },
          ]),
        )
      } else {
        response.end('[]')
      }
    })().catch(() => {
      response.writeHead(500)
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Fixture provider did not bind')
  providerOrigin = `http://127.0.0.1:${address.port}`
}, 120_000)
afterAll(async () => {
  setupClosed = true
  try {
    await templateWorker?.dispose()
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        }),
      )
  } finally {
    if (templates) await rm(templates.root, { recursive: true, force: true })
  }
})
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  const results = await Promise.allSettled(closers.splice(0).map((close) => close()))
  credentials.clear()
  calls.length = 0
  providerState.beforeResponse = undefined
  providerState.failure = false
  const errors = results.filter((result) => result.status === 'rejected')
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      'Wise fixture cleanup failed',
    )
})
export const data = <T>(value: T | Response): T => {
  if (value instanceof Response) throw new Error(`Unexpected response ${value.status}`)
  return value
}
export const status = (value: unknown) => (value instanceof Response ? value.status : 0)
export const fixture = async (backend: 'sqlite' | 'd1', name = 'A', profileId = '111', instant = initial) => {
  const root = await mkdtemp(join(tmpdir(), 'wise-case-'))
  let native: BetterSqlite3.Database | undefined, mf: Miniflare | undefined
  closers.push(async () => {
    try {
      native?.close()
      await mf?.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  let db: ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>
  let sessions:
    ReturnType<typeof createContainerSessionStore> | ReturnType<typeof createD1SessionStore>
  let now = instant,
    enabled = true
  let binding: D1Database | undefined
  if (backend === 'sqlite') {
    const path = join(root, 'tenant.sqlite')
    await copyFile(templates.sqlite, path)
    native = new BetterSqlite3(path)
    db = createContainerDatabase(native)
    sessions = createContainerSessionStore(native, { now: () => now })
  } else {
    await cp(templates.d1, root, { recursive: true })
    mf = new Miniflare({ ...worker, d1Persist: root })
    binding = await mf.getD1Database('DB')
    db = createD1Database(binding)
    sessions = createD1SessionStore(binding, { now: () => now })
  }
  const run = (query: string) => db.run(sql.raw(query))
  await run(
    `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned ${name}','{}','${now}','${now}')`,
  )
  await run(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES
    (1,'Owner','Fixture','administrator','[]','${now}','${now}'),
    (2,'Admin','Fixture','administrator','[]','${now}','${now}'),
    (3,'Member','Fixture','member','[]','${now}','${now}')`)
  const admin = await sessions.issue(2),
    member = await sessions.issue(3)
  const vault = await createManagedWiseVault({
    custodyKey: key(1),
    fingerprintKey: key(2),
    tenantBinding: `tenant-${name}`,
  })
  const store = createManagedWiseConnectionStore(db)
  const commands = createManagedWiseConnectionCommands({
    store,
    vault,
    now: () => now,
    authentication: { sessions: createApiSessionService(sessions) },
  })
  const request = (token = admin.token, origin = 'https://owned.example') =>
    new Request('https://owned.example/_hosted/wise/configure', {
      method: 'POST',
      headers: { origin, cookie: `__Host-ezacto_session=${token}` },
    })
  const token = `PRIVATE_WISE_${name}`
  credentials.set(`Bearer ${token}`, profileId)
  const configure = (
    commandId = 'a'.repeat(64),
    expectedGeneration = 0,
    secret = token,
    selected = profileId,
  ) =>
    commands.configure(request(), {
      commandId,
      expectedGeneration,
      credentials: { token: secret, profileId: selected },
    })
  const runtime = (database?: D1Database) => {
    const currentDb = database === undefined ? db : createD1Database(database)
    const accounts = createPayoutAccountStore(currentDb)
    return createManagedWiseRuntime({
      store: database === undefined ? store : createManagedWiseConnectionStore(currentDb),
      open: vault.open,
      accounts: {
        listForUser: (userId) => accounts.listForUser(userId),
        listForProvider: (provider) => accounts.listForProvider(provider),
        awaitingDestination: (provider) => accounts.awaitingDestination(provider),
      },
      isEnabled: () => enabled,
      assertAdmission: async () => {
        if (!enabled) throw new Error('PRIVATE_ADMISSION')
      },
      now: () => new Date(now),
      fetch: async (input, init) => {
        const request = new Request(input, init),
          url = new URL(request.url)
        expect(url.origin).toBe('https://api.wise.com')
        return fetch(new Request(new URL(url.pathname + url.search, providerOrigin), request))
      },
    })
  }
  const rows = (table: string) => db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`))
  const financial = async () =>
    Promise.all(
      ['invoices', 'invoice_payments', 'payout_transfers', 'payment_runs', 'payment_run_items'].map(
        rows,
      ),
    )
  return {
    binding,
    isEnabled: () => enabled,
    db,
    sessions,
    admin,
    member,
    vault,
    store,
    commands,
    request,
    configure,
    runtime,
    rows,
    financial,
    token,
    profileId,
    run,
    tick: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString()
    },
    now: () => now,
    disable: () => {
      enabled = false
    },
  }
}

