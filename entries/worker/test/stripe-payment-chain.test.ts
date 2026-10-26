import { createHmac } from 'node:crypto'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createD1Database } from '@ezacto/db/d1'
import { executeInvoiceLifecycleCommand } from '../../../packages/db/src/invoice-state.js'
import { createApp, type WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'

const secret = 'whsec_local_signed_chain_fixture'
const instant = '2026-10-20T12:00:00.000Z'

describe('signed Stripe checkout to the D1 payment ledger (#1131)', () => {
  let miniflare: Miniflare
  let database: D1Database
  let env: WorkerEnv
  let app: ReturnType<typeof createApp>
  let invoiceId = 0

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    })
    database = await miniflare.getD1Database('DB')
    env = {
      DB: database,
      API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
      ENVIRONMENT: 'test',
      RELEASE: 'stripe-chain-test',
      STRIPE_API_KEY: 'sk_test_local_fixture',
      STRIPE_WEBHOOK_SECRET: secret,
    }
    const services = await createRuntimeServices(env)
    await services.bootstrap({
      organizationName: 'Checkout fixture',
      ownerFirstName: 'Avery',
      ownerLastName: 'Admin',
      ownerEmail: 'owner@example.test',
      token: `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`,
    })
    await database
      .prepare('INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,?,?,?,?)')
      .bind('Checkout Client', 'USD', instant, instant)
      .run()
    app = createApp(services)
  })
  afterAll(async () => miniflare.dispose())

  const invoice = async () => {
    const id = ++invoiceId
    await database.batch([
      database
        .prepare(
          `INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,created_at,updated_at)
        VALUES(?,1,?,'USD','2026-10-20','2026-11-20',?,?)`,
        )
        .bind(id, `CHECKOUT-${id}`, instant, instant),
      database
        .prepare(
          `INSERT INTO invoice_line_items(invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at)
        VALUES(?,0,'Service','Advisory',1,10000,10000,?,?)`,
        )
        .bind(id, instant, instant),
    ])
    await executeInvoiceLifecycleCommand(createD1Database(database), {
      invoiceId: id,
      commandId: `send-${id}`,
      command: 'send',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: instant,
      messageId: id,
      eventId: `event-send-${id}`,
    })
    return id
  }
  const payload = (
    id: number,
    options: {
      event?: string
      eventId?: string
      payment?: string
      status?: string
      currency?: string
      amount?: number
      link?: string
      metadata?: boolean
    } = {},
  ) =>
    JSON.stringify({
      id: options.eventId ?? `evt-${id}`,
      type: options.event ?? 'checkout.session.completed',
      data: {
        object: {
          payment_status: options.status ?? 'paid',
          payment_intent: options.payment ?? `pi-${id}`,
          amount_total: options.amount ?? 10000,
          currency: options.currency ?? 'usd',
          metadata: options.metadata === false ? {} : { invoice_id: String(id) },
          payment_link: options.link ?? null,
        },
      },
    })
  const post = (body: string, options: { timestamp?: number; key?: string } = {}) => {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', options.key ?? secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    return app.request(
      'https://app.example.test/webhooks/stripe',
      { method: 'POST', body, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } },
      env,
    )
  }
  const state = (id: number) =>
    database
      .prepare(
        'SELECT state,due_amount_cents,(SELECT count(*) FROM invoice_payments WHERE invoice_id=invoices.id) AS payment_count FROM invoices WHERE id=?',
      )
      .bind(id)
      .first()
  const receipts = (id: number) =>
    database
      .prepare(
        'SELECT provider,provider_transaction_id,amount_cents FROM invoice_payments WHERE invoice_id=?',
      )
      .bind(id)
      .all()
  const events = async (id: number) =>
    (
      await database
        .prepare(
          `SELECT event_type,payload_json FROM event_outbox
    WHERE aggregate_type='invoice' AND aggregate_id=? AND event_type IN('payment.recorded','invoice.paid') ORDER BY aggregate_sequence`,
        )
        .bind(id)
        .all<{ event_type: string; payload_json: string }>()
    ).results

  it('[money] verifies a signed immediate payment and deduplicates both delivery and payment identities', async () => {
    const id = await invoice()
    const body = payload(id)
    expect((await post(body)).status).toBe(200)
    expect(await state(id)).toEqual({ state: 'paid', due_amount_cents: 0, payment_count: 1 })
    expect((await receipts(id)).results).toEqual([
      { provider: 'stripe', provider_transaction_id: `pi-${id}`, amount_cents: 10000 },
    ])
    const recorded = await events(id)
    expect(recorded.map((row) => row.event_type)).toEqual(['payment.recorded', 'invoice.paid'])
    expect(JSON.parse(recorded[0]!.payload_json)).toMatchObject({
      actor: { type: 'system', id: null },
    })
    expect((await post(body)).status).toBe(200)
    expect((await post(payload(id, { eventId: 'evt-redelivery-same-payment' }))).status).toBe(200)
    expect((await receipts(id)).results).toHaveLength(1)
    expect(await events(id)).toEqual(recorded)
  })

  it('[money] leaves unpaid/failed sessions open, then records delayed success through a known Payment Link', async () => {
    const id = await invoice()
    await database
      .prepare(
        `INSERT INTO stripe_payment_links(invoice_id,payment_link_id,url,created_at,updated_at)
      VALUES(?,?,'https://buy.stripe.com/test_fixture',?,?)`,
      )
      .bind(id, `plink-${id}`, instant, instant)
      .run()
    expect((await post(payload(id, { status: 'unpaid' }))).status).toBe(200)
    expect(
      (
        await post(
          payload(id, { event: 'checkout.session.async_payment_failed', status: 'unpaid' }),
        )
      ).status,
    ).toBe(200)
    expect(await state(id)).toEqual({ state: 'open', due_amount_cents: 10000, payment_count: 0 })
    expect(await events(id)).toEqual([])
    const body = payload(id, {
      event: 'checkout.session.async_payment_succeeded',
      metadata: false,
      link: `plink-${id}`,
    })
    expect((await post(body)).status).toBe(200)
    expect(await state(id)).toEqual({ state: 'paid', due_amount_cents: 0, payment_count: 1 })
    expect((await receipts(id)).results).toHaveLength(1)
    expect((await events(id)).map((row) => row.event_type)).toEqual([
      'payment.recorded',
      'invoice.paid',
    ])
    expect((await post(body)).status).toBe(200)
    expect((await receipts(id)).results).toHaveLength(1)
  })

  it('[security] forged/stale deliveries and foreign-currency sessions cannot write money', async () => {
    const id = await invoice()
    expect((await post(payload(id), { key: 'another-fixture-key' })).status).toBe(400)
    expect(
      (await post(payload(id), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status,
    ).toBe(400)
    expect((await post(payload(id, { currency: 'eur' }))).status).toBe(200)
    expect(await state(id)).toEqual({ state: 'open', due_amount_cents: 10000, payment_count: 0 })
    expect((await receipts(id)).results).toEqual([])
    expect(await events(id)).toEqual([])
  })

  it('[money] refuses an overpayment without reducing the invoice balance and reports it for reconciliation', async () => {
    const id = await invoice()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await post(payload(id, { amount: 10001 }))).status).toBe(200)
      expect(await state(id)).toEqual({ state: 'open', due_amount_cents: 10000, payment_count: 0 })
      expect((await receipts(id)).results).toEqual([])
      expect(await events(id)).toEqual([])
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('more than the invoice still owes'),
        expect.objectContaining({
          provider: 'stripe',
          providerTransactionId: `pi-${id}`,
          amountCents: 10001,
          dueAmountCents: 10000,
        }),
      )
    } finally {
      warning.mockRestore()
    }
  })
  it('[money] verified refunds and disputes flag the original receipt without changing paid state or duplicating events', async () => {
    const id = await invoice()
    const payment = `pi_alert_${id}`
    await post(payload(id, { payment }))
    const before = await state(id)
    const beforeEvents = await events(id)
    const report = (eventId:string,type:string,amount=5000,currency='usd',intent=payment) => JSON.stringify({id:eventId,type,created:1792454400,data:{object:{id:type==='charge.refunded'?'ch_owned':'dp_owned',payment_intent:intent,amount:10000,amount_refunded:amount,currency,refunded:false,status:'needs_response'}}})
    const refund = report('evt_owned_refund','charge.refunded')
    expect((await post(refund,{key:'forged'})).status).toBe(400)
    expect((await post(refund)).status).toBe(200)
    expect((await post(refund)).status).toBe(200)
    expect((await post(report('evt_wrong_currency','charge.refunded',5000,'eur'))).status).toBe(200)
    expect((await post(report('evt_too_large','charge.refunded',10001))).status).toBe(200)
    expect((await post(report('evt_unknown','charge.refunded',5000,'usd','pi_unknown'))).status).toBe(200)
    expect((await post(report('evt_owned_dispute','charge.dispute.created'))).status).toBe(200)
    const alerts=(await database.prepare('SELECT id,kind,amount_cents,reviewed_at FROM stripe_payment_alerts WHERE invoice_id=? ORDER BY id').bind(id).all()).results
    expect(alerts).toEqual([{id:'evt_owned_dispute',kind:'dispute',amount_cents:10000,reviewed_at:null},{id:'evt_owned_refund',kind:'refund',amount_cents:5000,reviewed_at:null}])
    expect(await state(id)).toEqual(before)
    expect(await events(id)).toEqual(beforeEvents)
    expect((await receipts(id)).results).toHaveLength(1)
  })

})
