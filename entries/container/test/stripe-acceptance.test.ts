import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createContainerSessionStore, executeInvoiceLifecycleCommand } from '@ezacto/db'
import { createApp } from '../../worker/src/app.js'
import type { ContainerConfig } from '../src/config.js'
import { createContainerRuntime } from '../src/runtime.js'

/**
 * Issue 102, Stripe acceptance: a signed `checkout.session.completed` posted to
 * the real `/webhooks/stripe` route settles the invoice exactly once, against a
 * real migrated database. The pieces were each proven alone (signature,
 * runtime, receipt); this drives them as one chain, with no stub in between.
 */

const secret = 'whsec_acceptance_secret'
const sent = '2026-09-11T12:00:00.000Z'
const roots: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const config = (root: string): ContainerConfig => ({
  host: '127.0.0.1',
  port: 3000,
  trustedProxyHops: 0,
  dataDirectory: root,
  databasePath: join(root, 'db.sqlite'),
  attachmentDirectory: join(root, 'attachments'),
  brandDirectory: join(root, 'brand'),
  appBaseUrl: 'http://localhost:3000',
  cursorSigningKey: new Uint8Array(32).fill(0x43),
  stripe: { apiKey: ['sk', 'test', 'placeholder'].join('_'), webhookSecret: secret },
  smtp: { url: 'smtp://127.0.0.1:2525', from: 'billing@example.test' },
  appEnv: {
    ENVIRONMENT: 'test-container',
    RELEASE: 'container-test',
    APP_BASE_URL: 'http://localhost:3000',
  },
})

const sign = async (payload: string): Promise<string> => {
  const timestamp = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${String(timestamp)}.${payload}`),
  )
  const hex = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${String(timestamp)},v1=${hex}`
}

const session = (
  eventId: string,
  overrides: { paymentIntent?: string; amount?: number; currency?: string } = {},
): string =>
  JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        payment_status: 'paid',
        payment_intent: overrides.paymentIntent ?? 'pi_acceptance',
        amount_total: overrides.amount ?? 100_000,
        currency: overrides.currency ?? 'usd',
        metadata: { invoice_id: '1' },
      },
    },
  })

const harness = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-stripe-')))
  roots.push(root)
  const configuration = config(root)
  const runtime = await createContainerRuntime(configuration, {})
  closers.push(() => runtime.close())
  const { database } = runtime
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${sent}', '${sent}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${sent}', '${sent}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${sent}', '${sent}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, payment_options, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-11', '2026-10-11', 'draft', '["stripe_checkout"]', '${sent}', '${sent}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (1, 0, 'Service', 'Advisory', 1, 100000, 100000, '${sent}', '${sent}');
  `)
  await executeInvoiceLifecycleCommand(createContainerDatabase(database), {
    invoiceId: 1,
    commandId: 'send-1315',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion: 0,
    occurredAt: sent,
    messageId: 301,
    eventId: 'event-send-1315',
  })
  const app = createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme)
  const post = async (payload: string, signature: string | null) =>
    app.request(
      `${configuration.appBaseUrl}/webhooks/stripe`,
      {
        method: 'POST',
        headers: signature === null ? {} : { 'stripe-signature': signature },
        body: payload,
      },
      configuration.appEnv,
    )
  const deliver = async (payload: string) => post(payload, await sign(payload))
  const state = () => ({
    invoice: database
      .prepare('SELECT state, due_amount_cents AS due FROM invoices WHERE id = 1')
      .get(),
    receipts: database
      .prepare(
        `SELECT provider, provider_transaction_id AS tx, amount_cents AS amount
         FROM invoice_payments WHERE invoice_id = 1`,
      )
      .all(),
    paidEvents: (
      database
        .prepare(
          `SELECT count(*) AS n FROM event_outbox
           WHERE aggregate_type = 'invoice' AND aggregate_id = 1 AND event_type = 'invoice.paid'`,
        )
        .get() as { n: number }
    ).n,
  })
  return { post, deliver, state, database, app, configuration }
}

describe('Stripe acceptance chain (issue 102)', () => {
  it('[money] a signed completed session marks the invoice paid and emits the event', async () => {
    const { deliver, state } = await harness()
    expect(state().invoice).toEqual({ state: 'open', due: 100_000 })

    const response = await deliver(session('evt_1'))

    expect(response.status).toBe(200)
    expect(state()).toEqual({
      invoice: { state: 'paid', due: 0 },
      receipts: [{ provider: 'stripe', tx: 'pi_acceptance', amount: 100_000 }],
      paidEvents: 1,
    })
  })

  it('[money] the same event delivered twice leaves one receipt and one event', async () => {
    const { deliver, state } = await harness()
    expect((await deliver(session('evt_1'))).status).toBe(200)
    expect((await deliver(session('evt_1'))).status).toBe(200)
    expect(state().receipts).toHaveLength(1)
    expect(state().paidEvents).toBe(1)
  })

  it('[money] a different event id for the same payment intent adds nothing', async () => {
    const { deliver, state } = await harness()
    expect((await deliver(session('evt_1'))).status).toBe(200)
    expect((await deliver(session('evt_2'))).status).toBe(200)
    expect(state()).toEqual({
      invoice: { state: 'paid', due: 0 },
      receipts: [{ provider: 'stripe', tx: 'pi_acceptance', amount: 100_000 }],
      paidEvents: 1,
    })
  })

  it('[security] an unsigned or forged delivery is a 400 and records nothing', async () => {
    const { post, state } = await harness()
    const payload = session('evt_1')
    expect((await post(payload, null)).status).toBe(400)
    expect(
      (await post(payload, `t=${String(Math.floor(Date.now() / 1000))},v1=deadbeef`)).status,
    ).toBe(400)
    expect(state()).toMatchObject({
      invoice: { state: 'open', due: 100_000 },
      receipts: [],
      paidEvents: 0,
    })
  })

  it('[money] a payment in another currency is acknowledged but not recorded', async () => {
    const { deliver, state } = await harness()
    expect(
      (await deliver(session('evt_1', { amount: 808_193_392, currency: 'crc' }))).status,
    ).toBe(200)
    expect(state()).toMatchObject({
      invoice: { state: 'open', due: 100_000 },
      receipts: [],
      paidEvents: 0,
    })
  })
  it('[money] signed provider reports remain visible and administrator review cannot alter receipts', async () => {
    const f = await harness()
    await f.deliver(session('evt_paid'))
    const before=f.state()
    const payload=JSON.stringify({id:'evt_refund',type:'charge.refunded',created:Math.floor(Date.now()/1000),data:{object:{id:'ch_owned',payment_intent:'pi_acceptance',amount:100000,amount_refunded:20000,currency:'usd',refunded:false}}})
    expect((await f.deliver(payload)).status).toBe(200)
    expect((await f.deliver(payload)).status).toBe(200)
    const issued=await createContainerSessionStore(f.database).issue(1)
    const headers={origin:f.configuration.appBaseUrl,cookie:`__Host-ezacto_session=${issued.token}`,'content-type':'application/json'}
    const request=(path:string,init:RequestInit={})=>f.app.request(`${f.configuration.appBaseUrl}/api/v1${path}`,{...init,headers:{...headers,...init.headers}},f.configuration.appEnv)
    const listed=await request('/invoices/1/provider-alerts')
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({data:[{id:'evt_refund',amount_cents:20000,reviewed_at:null}]})
    const reviewed=await request('/invoices/1/provider-alerts/evt_refund/review',{method:'POST',body:'{}'})
    expect(reviewed.status).toBe(200)
    expect(await reviewed.json()).toMatchObject({data:{id:'evt_refund',reviewed_by:1}})
    expect(f.state()).toEqual(before)
    expect(f.database.prepare('SELECT count(*) AS n FROM stripe_payment_alert_reviews').get()).toEqual({n:1})
  })

})
