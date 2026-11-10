import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { createD1Database, createD1SessionStore, createManagedBillConnectionStore,
  createBillLinkStore, createBillMirrorSource, createBillEffectFenceStore, executeInvoiceLifecycleCommand, migrateD1 } from '@ezacto/db/d1'
import { createApiSessionService, createManagedBillConnectionCommands } from '@ezacto/api'
import { createManagedBillVault } from '@ezacto/core'
import { createManagedBillRuntime } from '@ezacto/integrations'
import { createWorker } from '../src/index.js'
import { createRuntimeServices } from '../src/runtime.js'
import type { WorkerManagedBill } from '../src/managed-providers.js'
import type { WorkerEnv } from '../src/app.js'

const at = new Date().toISOString(), workers: Miniflare[] = []
let root: string, server: Server, origin: string, closed = false
const key = (n: number) => Buffer.alloc(32, n).toString('base64url')
const calls: { method: string; path: string; company: string; body?: unknown }[] = []
const created = new Set<string>()
const tenants: { binding: D1Database; cookie: string; member: string; company: string; enabled: boolean;
  vault: Awaited<ReturnType<typeof createManagedBillVault>> }[] = []
const scopes = new WeakMap<object, (typeof tenants)[number]>()
const composeRuntime = async ({ scope, database }: Parameters<WorkerManagedBill['compose']>[0], platformDevKey: string | undefined) => {
  const tenant = scopes.get(scope)
  if (!tenant) throw new Error('Unknown trusted tenant scope')
  const db = createD1Database(database)
  return createManagedBillRuntime({
    store: createManagedBillConnectionStore(db), open: tenant.vault.open, platformDevKey,
    isEnabled: async () => tenant.enabled,
    links: createBillLinkStore(db, () => new Date()),
    fence: generation => createBillEffectFenceStore(db, generation, () => new Date()), source: createBillMirrorSource(db, () => new Date()),
    now: () => new Date(),
    fetch: request => {
      const url = new URL(request.url)
      // The real client/parser targets an owned local HTTP transport only.
      return fetch(new Request(new URL(url.pathname + url.search, origin), request))
    },
  })
}
const compose = vi.fn((input: Parameters<WorkerManagedBill['compose']>[0]) => composeRuntime(input, 'OWNED_PLATFORM_KEY'))
const port: WorkerManagedBill = { configured: scope => scopes.get(scope)?.enabled === true, compose }
const environment = (tenant: (typeof tenants)[number]): WorkerEnv => ({
  DB: tenant.binding, ENVIRONMENT: 'test', RELEASE: 'a'.repeat(40),
  API_CURSOR_SIGNING_KEY: key(3), APP_BASE_URL: 'https://owned.example',
  BILL_DEV_KEY: 'PRIVATE_FOREIGN_DEV', BILL_COMPANY_ID: '008FOREIGN',
  BILL_USERNAME: 'PRIVATE_FOREIGN_USERNAME', BILL_PASSWORD: 'PRIVATE_FOREIGN_PASSWORD', BILL_REPLY_TO_USER_ID: 'PRIVATE_FOREIGN_REPLY',
})
const request = (path: string, cookie: string, method = 'GET', body?: unknown) => new Request(
  'https://owned.example/api/v1/integrations/bill' + path, { method,
    headers: { cookie, origin: 'https://owned.example', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  },
) as Request<unknown, IncomingRequestCfProperties>
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-bill-worker-'))
  const options = { modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] } as const
  const templatePath = join(root, 'template'), template = new Miniflare({ ...options, d1Persist: templatePath })
  workers.push(template)
  await migrateD1(await template.getD1Database('DB'))
  await template.dispose(); workers.splice(workers.indexOf(template), 1)
  if (closed) throw new Error('Fixture setup was closed')
  server = createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://local.test'), path = url.pathname
      let text = ''; for await (const part of incoming) text += String(part)
      const body = text ? JSON.parse(text) as Record<string, unknown> : undefined
      const company = path === '/connect/v3/login' ? String(body?.organizationId) : incoming.headers.sessionid?.toString().slice('session-'.length) ?? ''
      if (!['008OWNEDA', '008OWNEDB'].includes(company)) { response.writeHead(403); response.end('{}'); return }
      calls.push({ method: incoming.method ?? '', path, company, ...(body === undefined ? {} : { body }) })
      response.setHeader('content-type', 'application/json')
      if (path === '/connect/v3/login') {
        if (body?.devKey !== 'OWNED_PLATFORM_KEY' || body.username !== 'PRIVATE_USER_' + company || body.password !== 'PRIVATE_PASSWORD_' + company) {
          response.writeHead(401); response.end('{}'); return
        }
        response.end(JSON.stringify({ sessionId: 'session-' + company })); return
      }
      if (path === '/connect/v3/customers') {
        response.end(JSON.stringify(incoming.method === 'GET' ? { results: [] } : { id: '0cu' + company, name: 'Owned client' })); return
      }
      if (path === '/connect/v3/invoices' && incoming.method === 'GET') {
        response.end(JSON.stringify({ results: created.has(company) ? [{ id: '00e' + company, invoiceNumber: 'OWNED-15', totalAmount: 100, customerId: '0cu' + company }] : [] })); return
      }
      if (path === '/connect/v3/invoices' && incoming.method === 'POST') {
        created.add(company); response.end(JSON.stringify({ id: '00e' + company, invoiceNumber: 'OWNED-15' })); return
      }
      if (path === `/connect/v3/invoices/00e${company}/payment-link`) {
        response.end(JSON.stringify({ paymentLink: `https://owned.example/pay/${company}` })); return
      }
      if (path === '/connect/v3/receivable-payments') { response.end(JSON.stringify({ results: [] })); return }
      response.writeHead(404); response.end('{}')
    })().catch(() => { response.writeHead(500); response.end('{}') })
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
      binding.prepare("INSERT INTO organizations(name,modules,created_at,updated_at) VALUES(?,'{}',?,?)").bind(name,at,at),
      binding.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owner','Fixture','administrator','[]',?,?),(2,'Admin','Fixture','administrator','[]',?,?),(3,'Member','Fixture','member','[]',?,?)").bind(at,at,at,at,at,at),
      binding.prepare("INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(7,'Owned client','USD',?,?)").bind(at,at),
      binding.prepare("INSERT INTO contacts(id,client_id,first_name,email,invoice_recipient_status,created_at,updated_at) VALUES(1,7,'Owned','owned-client@example.test','recipient',?,?)").bind(at,at),
      binding.prepare("INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,state,created_at,updated_at) VALUES(15,7,'OWNED-15','USD','2026-10-01','2026-10-31','draft',?,?)").bind(at,at),
      binding.prepare("INSERT INTO invoice_line_items(invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at) VALUES(15,0,'Service','Owned work',1,10000,10000,?,?)").bind(at,at),
    ])
    const sessions = createD1SessionStore(binding), admin = await sessions.issue(2), member = await sessions.issue(3)
    const cookie = `__Host-ezacto_session=${admin.token}`, company = '008OWNED' + name
    const vault = await createManagedBillVault({ custodyKey: key(1), fingerprintKey: key(2), tenantBinding: 'owned-' + name })
    const commands = createManagedBillConnectionCommands({
      store: createManagedBillConnectionStore(createD1Database(binding)), vault,
      authentication: { sessions: createApiSessionService(sessions) }, now: () => at,
    })
    const accepted = await commands.configure(request('', cookie, 'POST'), {
      commandId: 'a'.repeat(64), expectedGeneration: 0,
      credentials: { companyId: company, username: 'PRIVATE_USER_' + company, password: 'PRIVATE_PASSWORD_' + company, replyToUserId: null, environment: 'sandbox' },
    })
    if (accepted instanceof Response) throw new Error(`Native configure refused ${accepted.status}`)
    expect(accepted.generation).toBe(1)
    const tenant = { binding, cookie, member: `__Host-ezacto_session=${member.token}`, company, enabled: true, vault }
    tenants.push(tenant); scopes.set(binding, tenant)
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

it.each([0, 1])('[integration #1252] Worker tenant %s composes native BILL status and resumes an opted-in outbox mirror without environment fallback', async index => {
  const tenant = tenants[index]!, env = environment(tenant), worker = createWorker({ managedBill: port })
  const before = calls.length
  expect((await worker.fetch!(request('', tenants[1 - index]!.cookie), env, context)).status).toBe(401)
  expect((await worker.fetch!(request('', tenant.member), env, context)).status).toBe(403)
  const status = await worker.fetch!(request('', tenant.cookie), env, context)
  expect(status.status).toBe(200)
  const text = await status.text()
  expect(JSON.parse(text)).toMatchObject({ data: { configured: true, company_id: tenant.company, can_send_from_bill: false } })
  expect(text).not.toMatch(/PRIVATE_|OWNED_PLATFORM_KEY|sealed/)
  expect(calls).toHaveLength(before)
  expect((await worker.fetch!(request('/clients/7', tenant.cookie, 'POST', { deliver_via_bill: true }), env, context)).status).toBe(200)
  const db = createD1Database(tenant.binding)
  await executeInvoiceLifecycleCommand(db, { invoiceId: 15, commandId: 'owned-send', command: 'send',
    actor: { type: 'user', id: 2 }, authorize: async () => true, expectedVersion: 0, occurredAt: at,
    messageId: 1, eventId: 'owned-invoice-sent',
  })
  const actuals = () => tenant.binding.prepare('SELECT state,amount_cents,due_amount_cents,version FROM invoices WHERE id=15').first()
  const financialBefore = await actuals()
  tenant.enabled = false
  const disabled = await createRuntimeServices(env, { managedBill: port })
  expect((await disabled.bill!.status()).configured).toBe(false)
  await disabled.outbox.drain(100)
  expect(calls).toHaveLength(before)
  expect(await tenant.binding.prepare("SELECT status,attempt_count FROM outbox_delivery_receipts WHERE subscriber_id='bill_mirror' AND event_id='owned-invoice-sent'").first())
    .toMatchObject({ status: 'pending', attempt_count: 0 })
  tenant.enabled = true
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61_000)
  try {
    const active = await createRuntimeServices(env, { managedBill: port })
    await active.outbox.drain(100)
    expect(await tenant.binding.prepare("SELECT status,attempt_count FROM outbox_delivery_receipts WHERE subscriber_id='bill_mirror' AND event_id='owned-invoice-sent'").first())
      .toMatchObject({ status: 'delivered', attempt_count: 1 })
    expect(calls.slice(before).every(call => call.company === tenant.company)).toBe(true)
    expect(calls.slice(before).filter(call => call.path === '/connect/v3/invoices' && call.method === 'POST')).toHaveLength(1)
    const restarted = await createRuntimeServices(env, { managedBill: port })
    await restarted.outbox.drain(100)
    await restarted.bill!.reconcilePayments()
    expect(calls.slice(before).filter(call => call.path === '/connect/v3/invoices' && call.method === 'POST')).toHaveLength(1)
    expect(calls.slice(before).filter(call => call.path.endsWith('/email'))).toHaveLength(0)
    expect(await actuals()).toEqual(financialBefore)
    expect((await tenant.binding.prepare('SELECT count(*) AS n FROM invoice_payments').first())?.n).toBe(0)
  } finally { vi.useRealTimers() }
  const absent = { configured: () => true, compose: vi.fn(async () => null) }
  expect((await (await createRuntimeServices(env, { managedBill: absent })).bill!.status()).configured).toBe(false)
  const noKey: WorkerManagedBill = { configured: () => true, compose: input => composeRuntime(input, undefined) }
  const unavailable = await createRuntimeServices(env, { managedBill: noKey })
  expect(await unavailable.bill!.status()).toMatchObject({ configured: false, platformKeyConfigured: false, canSendFromBill: false })
  expect(await unavailable.bill!.reconcilePayments()).toBe(0)
  for (const extra of [{ DEMO_MODE: 'true', ENVIRONMENT: 'dev' }, { ACCOUNTING_ENABLED: 'false' }]) {
    const count = compose.mock.calls.length
    expect((await (await createRuntimeServices({ ...env, ...extra }, { managedBill: port })).bill!.status()).configured).toBe(false)
    expect(compose.mock.calls.length).toBe(count)
  }
})
