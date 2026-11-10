import { copyFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'
import { createManagedWiseConnectionStore } from '../src/managed-wise.js'
import { createPayoutAccountStore } from '../src/payout-accounts.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createApiSessionService } from '../../api/src/sessions.js'
import { createManagedWiseConnectionCommands, createApiApp } from '../../api/src/index.js'
import { installWiseRoutes } from '../../api/src/wise.js'
import { createManagedWiseRuntime } from '../../integrations/src/wise/managed.js'
import { createManagedWiseVault, ManagedWiseUnavailableError } from '@ezacto/core'

const initial = '2026-10-24T18:00:00.000Z'
const key = (n: number) =>
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
const credentials = new Map<string, string>()
const calls: { profile: string; path: string; method: string }[] = []
let beforeResponse: (() => Promise<void>) | undefined
let providerFailure = false
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
      const run = beforeResponse
      beforeResponse = undefined
      await run?.()
      if (providerFailure) {
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
        server.close((error) => (error ? reject(error) : resolve())),
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
  beforeResponse = undefined
  providerFailure = false
  const errors = results.filter((result) => result.status === 'rejected')
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      'Wise fixture cleanup failed',
    )
})
const data = <T>(value: T | Response): T => {
  if (value instanceof Response) throw new Error(`Unexpected response ${value.status}`)
  return value
}
const status = (value: unknown) => (value instanceof Response ? value.status : 0)
const fixture = async (backend: 'sqlite' | 'd1', name = 'A', profileId = '111') => {
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
  let now = initial,
    enabled = true
  if (backend === 'sqlite') {
    const path = join(root, 'tenant.sqlite')
    await copyFile(templates.sqlite, path)
    native = new BetterSqlite3(path)
    db = createContainerDatabase(native)
    sessions = createContainerSessionStore(native, { now: () => now })
  } else {
    await cp(templates.d1, root, { recursive: true })
    mf = new Miniflare({ ...worker, d1Persist: root })
    const binding = await mf.getD1Database('DB')
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
  const accounts = createPayoutAccountStore(db)
  const runtime = () =>
    createManagedWiseRuntime({
      store,
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
  const rows = (table: string) => db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`))
  const financial = async () =>
    Promise.all(
      ['invoices', 'invoice_payments', 'payout_transfers', 'payment_runs', 'payment_run_items'].map(
        rows,
      ),
    )
  return {
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

describe.each(['sqlite', 'd1'] as const)('managed Wise read-only %s', (backend) => {
  it('isolates two native tenants through real API reads and never exposes payment or secret capability', async () => {
    const a = await fixture(backend, 'A', '111'),
      b = await fixture(backend, 'B', '222')
    for (const t of [a, b]) {
      expect(data(await t.configure())).toMatchObject({
        generation: 1,
        status: 'configured',
        profileId: t.profileId,
      })
      const before = await t.financial(),
        runtime = await t.runtime()
      expect(runtime).not.toHaveProperty('webhook')
      expect(runtime).not.toHaveProperty('paymentProvider')
      const app = createApiApp({
        authentication: { sessions: createApiSessionService(t.sessions) },
        installApi: (api) => installWiseRoutes(api, runtime.service),
      })
      const call = (path: string, token = t.admin.token, method = 'GET') =>
        app.fetch(
          new Request(`https://owned.example/api/v1/integrations/wise${path}`, {
            method,
            headers: { origin: 'https://owned.example', cookie: `__Host-ezacto_session=${token}` },
          }),
        )
      const initialCalls = calls.length
      expect((await call('/recipients', t.member.token)).status).toBe(403)
      expect(calls).toHaveLength(initialCalls)
      const response = await call('')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        data: {
          configured: true,
          connection: { profile_id: t.profileId, webhooks_verifiable: false },
        },
      })
      const recipients = await call('/recipients')
      expect(recipients.status).toBe(200)
      const text = await recipients.text()
      expect(text).toContain('ending in 2345')
      expect(text).toContain('9007199254740993123')
      expect(text).not.toMatch(/PRIVATE_|123456789012345|accountSummary|accountNumber/)
      for (const path of ['/recipients/link', '/recipients', '/contacts'])
        expect((await call(path, t.admin.token, 'POST')).status).toBe(403)
      expect(
        calls
          .slice(initialCalls)
          .every((call) => call.method === 'GET' && call.profile === t.profileId),
      ).toBe(true)
      expect(await t.store.state()).toMatchObject({ status: 'connected' })
      expect(await t.financial()).toEqual(before)
      expect(JSON.stringify(await t.rows('wise_managed_connection'))).not.toContain(t.token)
    }
    const envelope = (await a.store.readSealed())!
    await expect(b.vault.open(envelope.sealed, envelope.generation)).rejects.toThrow()
  })
  it('requires fresh session/origin/admin authority, fences exact replay, and inventories custody for closure', async () => {
    const t = await fixture(backend)
    const command = {
      commandId: 'a'.repeat(64),
      expectedGeneration: 0,
      credentials: { token: t.token, profileId: t.profileId },
    }
    expect(status(await t.commands.configure(t.request(t.member.token), command))).toBe(403)
    expect(
      status(
        await t.commands.configure(t.request(t.admin.token, 'https://foreign.example'), command),
      ),
    ).toBe(403)
    expect(data(await t.configure()).outcome).toBe('applied')
    expect(data(await t.configure()).outcome).toBe('replayed')
    expect(status(await t.configure('a'.repeat(64), 0, 'PRIVATE_CHANGED'))).toBe(409)
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 1, commandReceipts: 1 })
    await createAccountRetentionRepository(t.db).publish({
      actorUserId: 1,
      expectedVersion: 0,
      now: t.now(),
      policy: {
        frameworks: [],
        retained_records: [
          {
            category: 'billing_and_payments',
            reason: 'Owned fixture review.',
            period: 'One year then review.',
            review_after_days: 30,
          },
        ],
        response_target_days: 14,
        operator_contact: 'privacy@example.test',
        user_notice: 'Reviewed closure.',
        backup_handling: 'Replay closure.',
        acknowledged: true,
      },
    })
    await createAccountDeletionRequestRepository(t.db).request({
      userId: 2,
      id: 'owned-wise-closure',
      now: t.now(),
      expectedPolicyVersion: 1,
    })
    const preview = await createAccountClosureRepository(t.db).preview(1, 'owned-wise-closure')
    expect(preview.inventory).toContainEqual({
      location: 'wise_managed_commands.actor_id',
      count: 1,
      category: 'billing_and_payments',
    })
    expect(preview.inventory).toContainEqual({
      location: 'wise_managed_connection.connected_by_user_id',
      count: 1,
      category: 'billing_and_payments',
    })
    t.tick(15 * 60_000 + 1)
    expect(
      status(
        await t.commands.disconnect(t.request(), {
          commandId: 'b'.repeat(64),
          expectedGeneration: 1,
        }),
      ),
    ).toBe(403)
    expect(status(await t.configure('b'.repeat(64), 1))).toBe(403)
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 1, commandReceipts: 1 })
    await t.store.erase(t.now())
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 0, commandReceipts: 0 })
    expect(await t.store.state()).toMatchObject({ generation: 2, status: 'disconnected' })
  })
  it('refuses late replies after rotation/disconnect and makes provider failures visibly unavailable', async () => {
    const t = await fixture(backend)
    data(await t.configure())
    const runtime = await t.runtime()
    beforeResponse = async () => {
      data(await t.configure('b'.repeat(64), 1, 'PRIVATE_ROTATED'))
      credentials.set('Bearer PRIVATE_ROTATED', t.profileId)
    }
    await expect(runtime.service.readStatus()).rejects.toBeInstanceOf(ManagedWiseUnavailableError)
    expect(await t.store.state()).toMatchObject({ generation: 2, status: 'configured' })
    beforeResponse = async () => {
      data(
        await t.commands.disconnect(t.request(), {
          commandId: 'c'.repeat(64),
          expectedGeneration: 2,
        }),
      )
    }
    await expect(runtime.service.readStatus()).rejects.toBeInstanceOf(ManagedWiseUnavailableError)
    const count = calls.length
    expect(await runtime.service.readStatus()).toBeNull()
    expect(calls).toHaveLength(count)
    data(await t.configure('d'.repeat(64), 3))
    providerFailure = true
    await expect((await t.runtime()).service.readStatus()).rejects.toThrow(
      'The Wise connection is unavailable or changed. Reopen its settings.',
    )
    expect(await t.store.state()).toMatchObject({ generation: 4, status: 'unavailable' })
  })
  it('performs no provider I/O while disabled/disconnected/erased and rejects a foreign profile', async () => {
    const t = await fixture(backend),
      runtime = await t.runtime()
    expect(await runtime.service.readStatus()).toBeNull()
    expect(calls).toHaveLength(0)
    data(await t.configure('a'.repeat(64), 0, t.token, '222'))
    await expect((await t.runtime()).service.readStatus()).rejects.toBeInstanceOf(
      ManagedWiseUnavailableError,
    )
    expect(calls.every((call) => call.path === '/v2/profiles')).toBe(true)
    expect(await t.store.state()).toMatchObject({ status: 'unavailable' })
    t.disable()
    const count = calls.length
    const disabled = await t.runtime()
    expect(disabled.service.configured()).toBe(false)
    expect(await disabled.service.readStatus()).toBeNull()
    expect(await disabled.service.listRecipients()).toEqual([])
    expect(calls).toHaveLength(count)
    await t.store.erase(t.now())
    expect(await disabled.service.readStatus()).toBeNull()
    expect(calls).toHaveLength(count)
  })
})
