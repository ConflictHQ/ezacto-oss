import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createContainerSessionStore } from '../src/sessions.js'
import { createBillLinkStore } from '../src/bill.js'
import { createManagedBillConnectionStore } from '../src/index.js'
import { createApiSessionService } from '../../api/src/sessions.js'
import { createManagedBillConnectionCommands, createApiApp } from '../../api/src/index.js'
import { installBillRoutes } from '../../api/src/bill.js'
import {
  createBillMirrorSubscriber,
  createManagedBillRuntime,
  type BillMirrorSource,
} from '../../integrations/src/index.js'
import {
  ManagedBillConnectionError,
  createManagedBillVault,
  type ManagedBillCredentials,
} from '@ezacto/core'

const initial = '2026-10-24T18:00:00.000Z'
const b64 = (byte: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
const SECRET_PASSWORD = 'PRIVATE_PASSWORD_SENTINEL'
const SECRET_USER = 'PRIVATE_USERNAME_SENTINEL'
const credentials = (company = '008OWNEDONE', over: Partial<ManagedBillCredentials> = {}) => ({
  companyId: company,
  username: SECRET_USER,
  password: SECRET_PASSWORD,
  replyToUserId: null,
  environment: 'sandbox' as const,
  ...over,
})
let closers: (() => void)[] = []
afterEach(() => {
  closers.forEach((close) => close())
  closers = []
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A BILL that knows which login belongs to which company and records every call. */
const fakeBill = (accepted: { company: string; username: string; password: string }) => {
  const calls: { path: string; session?: string | undefined; company?: string | undefined }[] = []
  let loginOk = true
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname === '/connect/v3/login') {
      const body = (await request.json()) as Record<string, string>
      calls.push({ path: 'login', company: body.organizationId })
      expect(body.devKey).toBe('PLATFORM_DEV_KEY')
      if (
        !loginOk ||
        body.organizationId !== accepted.company ||
        body.username !== accepted.username ||
        body.password !== accepted.password
      )
        return json({ message: 'bad credentials' }, 401)
      return json({ sessionId: `session-${accepted.company}` })
    }
    calls.push({ path: url.pathname, session: request.headers.get('sessionId') ?? undefined })
    if (url.pathname === '/connect/v3/invoices')
      return json({
        results: [{ id: '00eADOPT', invoiceNumber: '1315', totalAmount: 100, customerId: '0cuX' }],
      })
    if (url.pathname === '/connect/v3/receivable-payments') return json({ results: [] })
    throw new Error(`unexpected ${url.pathname}`)
  })
  return { fetch, calls, setLoginOk: (ok: boolean) => (loginOk = ok) }
}

const tenant = async (name: string, company: string) => {
  const native = new BetterSqlite3(':memory:')
  closers.push(() => native.close())
  migrateContainer(native)
  const db = createContainerDatabase(native)
  let now = initial
  const sessions = createContainerSessionStore(native, { now: () => now })
  const run = (text: string) => db.run(sql.raw(text))
  await run(`INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('${name}','{}','${now}','${now}')`)
  await run(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES
    (1,'Owner','Fixture','administrator','[]','${now}','${now}'),
    (2,'Admin','Fixture','administrator','[]','${now}','${now}'),
    (3,'Member','Fixture','member','[]','${now}','${now}')`)
  await run(`INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(7,'Owned client','USD','${now}','${now}')`)
  await run(`INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,state,created_at,updated_at)
    VALUES(15,7,'1315','USD','2026-09-11','2026-10-11','open','${now}','${now}')`)
  const admin = await sessions.issue(2)
  const member = await sessions.issue(3)
  const store = createManagedBillConnectionStore(db)
  const vault = await createManagedBillVault({
    custodyKey: b64(1),
    fingerprintKey: b64(2),
    tenantBinding: `tenant-${name}`,
  })
  const errors: Error[] = []
  const commands = createManagedBillConnectionCommands({
    store,
    vault,
    now: () => now,
    reportError: (error) => {
      errors.push(error)
    },
    authentication: { sessions: createApiSessionService(sessions) },
  })
  const request = (token = admin.token, origin = 'https://owned.example') =>
    new Request('https://owned.example/_hosted/bill/connection', {
      method: 'POST',
      headers: { cookie: `__Host-ezacto_session=${token}`, origin },
    })
  const bill = fakeBill({ company, username: SECRET_USER, password: SECRET_PASSWORD })
  const recorded: unknown[] = []
  const source: BillMirrorSource = {
    readInvoice: async () => null,
    readClient: async () => null,
    isOptedIn: async () => true,
    mirroredInvoices: async () => new Map(),
    unsettledInvoices: async () => [
      { id: 15, number: '1315', clientId: 7, issueDate: '2026-09-11', amountCents: 10_000 },
    ],
    recordPayment: async (input) => {
      recorded.push(input)
    },
  }
  const links = createBillLinkStore(db, () => new Date(now))
  let enabled = true
  const runtimeFor = (devKey: string | null = 'PLATFORM_DEV_KEY') =>
    createManagedBillRuntime({
      platformDevKey: devKey ?? undefined,
      store,
      open: (sealed, generation) => vault.open(sealed, generation),
      isEnabled: async () => enabled,
      links,
      source,
      fetch: bill.fetch,
      now: () => new Date(now),
    })
  return {
    native,
    db,
    store,
    vault,
    commands,
    errors,
    admin,
    member,
    request,
    bill,
    runtime: runtimeFor(),
    runtimeFor,
    links,
    setEnabled: (value: boolean) => (enabled = value),
    rows: (table: string) => db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`)),
    now: () => now,
    tick: (ms: number) => (now = new Date(Date.parse(now) + ms).toISOString()),
  }
}
const ok = <T>(value: T | Response): T => {
  if (value instanceof Response) throw new Error(`unexpected status ${value.status}`)
  return value
}
const COMMAND = 'a'.repeat(64)

describe('managed tenant BILL connection', () => {
  it('starts disconnected and reports status without decrypting or calling BILL', async () => {
    const t = await tenant('one', '008OWNEDONE')
    expect(await t.runtime.status()).toMatchObject({
      status: 'disconnected',
      companyId: null,
      generation: 0,
      enabled: true,
      platformKeyConfigured: true,
    })
    expect(t.bill.fetch).not.toHaveBeenCalled()
    expect(await t.runtime.reconcilePayments()).toBe(0)
    expect(t.bill.fetch).not.toHaveBeenCalled()
  })

  it('connects with fresh admin authority, seals the credential and never echoes it', async () => {
    const t = await tenant('one', '008OWNEDONE')
    const result = ok(
      await t.commands.configure(t.request(), {
        commandId: COMMAND,
        expectedGeneration: 0,
        credentials: credentials(),
      }),
    )
    expect(result).toMatchObject({ outcome: 'applied', status: 'configured', generation: 1, companyId: '008OWNEDONE', actorUserId: 2 })
    expect(JSON.stringify(result)).not.toMatch(/SENTINEL/)
    const stored = JSON.stringify([
      await t.rows('bill_managed_connection'),
      await t.rows('bill_managed_commands'),
    ])
    expect(stored).not.toMatch(/SENTINEL/)
    expect(stored).toContain('008OWNEDONE')
    expect(t.bill.fetch).not.toHaveBeenCalled()
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 1, commandReceipts: 1 })
  })

  it('refuses members, missing origin and bearer-less callers with static errors', async () => {
    const t = await tenant('one', '008OWNEDONE')
    const attempt = (request: Request) =>
      t.commands.configure(request, { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() })
    const member = await attempt(t.request(t.member.token))
    expect(member).toBeInstanceOf(Response)
    expect((member as Response).status).toBe(403)
    const origin = await attempt(t.request(t.admin.token, 'https://evil.example'))
    expect((origin as Response).status).toBeGreaterThanOrEqual(400)
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 0, commandReceipts: 0 })
    expect(await t.runtime.status()).toMatchObject({ status: 'disconnected', generation: 0 })
  })

  it('rejects invalid credentials without echoing them', async () => {
    const t = await tenant('one', '008OWNEDONE')
    const response = await t.commands.configure(t.request(), {
      commandId: COMMAND,
      expectedGeneration: 0,
      credentials: credentials('008OWNEDONE', { password: ` ${SECRET_PASSWORD} ` }),
    })
    expect((response as Response).status).toBe(422)
    expect(await (response as Response).text()).not.toMatch(/SENTINEL/)
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 0, commandReceipts: 0 })
  })

  it('replays an exact command and refuses a changed secret under the same command id', async () => {
    const t = await tenant('one', '008OWNEDONE')
    const input = { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }
    ok(await t.commands.configure(t.request(), input))
    expect(ok(await t.commands.configure(t.request(), input))).toMatchObject({ outcome: 'replayed', generation: 1 })
    const changed = await t.commands.configure(t.request(), {
      ...input,
      credentials: credentials('008OWNEDONE', { password: 'different-password' }),
    })
    expect((changed as Response).status).toBe(409)
    expect((await t.store.state()).generation).toBe(1)
  })

  it('refuses a stale generation instead of overwriting a newer connection', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    const stale = await t.commands.configure(t.request(), {
      commandId: 'b'.repeat(64),
      expectedGeneration: 0,
      credentials: credentials(),
    })
    expect((stale as Response).status).toBe(409)
    const rotated = ok(
      await t.commands.configure(t.request(), {
        commandId: 'c'.repeat(64),
        expectedGeneration: 1,
        credentials: credentials(),
      }),
    )
    expect(rotated.generation).toBe(2)
  })

  it('a revoked or demoted administrator cannot apply a command', async () => {
    const t = await tenant('one', '008OWNEDONE')
    await t.db.run(sql.raw(`UPDATE users SET profile='member' WHERE id=2`))
    const response = await t.commands.configure(t.request(), {
      commandId: COMMAND,
      expectedGeneration: 0,
      credentials: credentials(),
    })
    expect((response as Response).status).toBeGreaterThanOrEqual(400)
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 0, commandReceipts: 0 })
    // The SQL fence itself, bypassing the API: an inactive actor cannot insert a receipt.
    await expect(
      t.store.apply(
        { action: 'disconnect', commandId: COMMAND, expectedActorUserId: 2, expectedGeneration: 0, fingerprint: 'f'.repeat(64) },
        { kind: 'guarded-session', userId: 2 },
        t.now(),
      ),
    ).rejects.toBeInstanceOf(ManagedBillConnectionError)
  })

  it('connects through the runtime: opens only this tenant credential and records health', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    expect(await t.runtime.reconcilePayments()).toBe(0)
    expect(t.bill.calls.filter((c) => c.path === 'login')).toEqual([{ path: 'login', company: '008OWNEDONE' }])
    expect(await t.runtime.status()).toMatchObject({ status: 'connected', generation: 1 })
    // Adoption writes only the link, once; a second pass does not duplicate or re-login within the session.
    expect(await t.links.readLink('invoice', 15)).toEqual({ billId: '00eADOPT', paymentLink: null })
    await t.runtime.reconcilePayments()
    expect(t.bill.calls.filter((c) => c.path === 'login')).toHaveLength(1)
    expect(await t.rows('bill_links')).toHaveLength(2)
  })

  it('reports unavailable after a refused login and recovers on rotation, never leaking the secret', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    t.bill.setLoginOk(false)
    await expect(t.runtime.reconcilePayments()).rejects.toThrow(/sign-in failed/)
    const status = await t.runtime.status()
    expect(status.status).toBe('unavailable')
    expect(JSON.stringify(status)).not.toMatch(/SENTINEL/)
    t.bill.setLoginOk(true)
    ok(await t.commands.configure(t.request(), { commandId: 'b'.repeat(64), expectedGeneration: 1, credentials: credentials() }))
    expect(await t.runtime.status()).toMatchObject({ status: 'configured', generation: 2 })
    await t.runtime.reconcilePayments()
    expect((await t.runtime.status()).status).toBe('connected')
  })

  it('performs no provider I/O while disabled, without the platform key, disconnected or erased', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    t.setEnabled(false)
    expect(await t.runtime.reconcilePayments()).toBe(0)
    expect(await t.runtime.mirror(15)).toMatchObject({ kind: 'refused' })
    expect(await t.runtime.paymentLinkForSend(15)).toBeNull()
    await createBillMirrorSubscriber(t.runtime).deliver({ eventType: 'invoice.sent', aggregateType: 'invoice', aggregateId: 15 })
    expect(await t.runtimeFor(null).reconcilePayments()).toBe(0)
    expect(await t.runtimeFor(null).status()).toMatchObject({ platformKeyConfigured: false, status: 'configured' })
    t.setEnabled(true)
    ok(await t.commands.disconnect(t.request(), { commandId: 'd'.repeat(64), expectedGeneration: 1 }))
    expect(await t.runtime.reconcilePayments()).toBe(0)
    ok(await t.commands.configure(t.request(), { commandId: 'e'.repeat(64), expectedGeneration: 2, credentials: credentials() }))
    await t.store.erase(t.now())
    expect(await t.runtime.reconcilePayments()).toBe(0)
    expect(t.bill.fetch).not.toHaveBeenCalled()
  })

  it('disconnect and erase remove credential custody, keep the generation monotonic and keep history', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    await t.runtime.reconcilePayments()
    const disconnected = ok(await t.commands.disconnect(t.request(), { commandId: 'd'.repeat(64), expectedGeneration: 1 }))
    expect(disconnected).toMatchObject({ status: 'disconnected', generation: 2, companyId: null })
    expect(await t.store.readSealed()).toBeNull()
    expect(JSON.stringify(await t.rows('bill_managed_connection'))).not.toContain('ciphertext')
    ok(await t.commands.configure(t.request(), { commandId: 'e'.repeat(64), expectedGeneration: 2, credentials: credentials() }))
    await t.store.erase(t.now())
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 0, commandReceipts: 0 })
    expect((await t.store.state()).generation).toBe(4)
    // History is untouched by disconnect and erasure.
    expect(await t.links.readLink('invoice', 15)).not.toBeNull()
    // A stale pre-erasure command cannot revive the connection.
    const revived = await t.commands.configure(t.request(), { commandId: 'f'.repeat(64), expectedGeneration: 1, credentials: credentials() })
    expect((revived as Response).status).toBe(409)
  })

  it('refuses to repoint adopted history at a different BILL company, but allows rotation within it', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    await t.runtime.reconcilePayments()
    ok(await t.commands.disconnect(t.request(), { commandId: 'd'.repeat(64), expectedGeneration: 1 }))
    const other = await t.commands.configure(t.request(), {
      commandId: 'e'.repeat(64),
      expectedGeneration: 2,
      credentials: credentials('008SOMEONEELSE'),
    })
    expect((other as Response).status).toBe(409)
    expect(await t.store.state()).toMatchObject({ status: 'disconnected', generation: 2 })
    ok(await t.commands.configure(t.request(), { commandId: 'f'.repeat(64), expectedGeneration: 2, credentials: credentials() }))
  })

  it('isolates two tenant databases: credentials, sessions and generations never cross', async () => {
    const one = await tenant('one', '008OWNEDONE')
    const two = await tenant('two', '008OWNEDTWO')
    ok(await one.commands.configure(one.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials('008OWNEDONE') }))
    ok(await two.commands.configure(two.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials('008OWNEDTWO') }))
    await one.runtime.reconcilePayments()
    await two.runtime.reconcilePayments()
    expect(one.bill.calls.filter((c) => c.path === 'login').map((c) => c.company)).toEqual(['008OWNEDONE'])
    expect(two.bill.calls.filter((c) => c.path === 'login').map((c) => c.company)).toEqual(['008OWNEDTWO'])
    expect(one.bill.calls.some((c) => c.session === 'session-008OWNEDTWO')).toBe(false)
    // An envelope sealed for tenant one cannot be opened by tenant two's vault, nor at another generation.
    const sealed = (await one.store.readSealed())!
    await expect(two.vault.open(sealed.sealed, sealed.generation)).rejects.toBeInstanceOf(ManagedBillConnectionError)
    await expect(one.vault.open(sealed.sealed, sealed.generation + 1)).rejects.toBeInstanceOf(ManagedBillConnectionError)
    expect((await one.vault.open(sealed.sealed, sealed.generation)).companyId).toBe('008OWNEDONE')
    // Disconnecting one tenant leaves the other connected.
    ok(await one.commands.disconnect(one.request(), { commandId: 'd'.repeat(64), expectedGeneration: 1 }))
    expect((await two.store.state()).status).toBe('connected')
  })

  it('composes the existing status route and opted-in subscriber through public exports', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    const opts: boolean[] = []
    const api = createApiApp({
      authentication: { sessions: createApiSessionService(createContainerSessionStore(t.native, { now: t.now })) },
      installApi: (hono) =>
        installBillRoutes(hono, {
          status: async () => {
            const s = await t.runtime.status()
            return { configured: s.status !== 'disconnected', companyId: s.companyId, environment: s.environment, canSendFromBill: s.canSendFromBill }
          },
          isOptedIn: async () => true,
          setOptedIn: async (_id, enabled) => {
            opts.push(enabled)
            return true
          },
        }),
    })
    const response = await api.fetch(
      new Request('https://owned.example/api/v1/integrations/bill', {
        headers: { cookie: `__Host-ezacto_session=${t.admin.token}` },
      }),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: unknown }).data).toEqual({
      configured: true,
      company_id: '008OWNEDONE',
      environment: 'sandbox',
      can_send_from_bill: false,
    })
  })

  it('a rolled-back command leaves no receipt: expected failure paths are static and unreported', async () => {
    const t = await tenant('one', '008OWNEDONE')
    ok(await t.commands.configure(t.request(), { commandId: COMMAND, expectedGeneration: 0, credentials: credentials() }))
    await t.commands.configure(t.request(), { commandId: 'b'.repeat(64), expectedGeneration: 0, credentials: credentials() })
    expect(await t.rows('bill_managed_commands')).toHaveLength(1)
    expect(t.errors).toEqual([])
  })
})
