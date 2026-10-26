import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { executeInvoiceLifecycleCommand } from '../src/invoice-state.js'
import { recordCheckoutPayment } from '../src/checkout-payments.js'
import {
  createStripePaymentAlertStore,
  prepareStripePaymentAlertNotifications,
} from '../src/stripe-payment-alerts.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'
const close: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(close.splice(0).map((f) => f()))
})
const now = new Date().toISOString()
const setup = async (kind: 'sqlite' | 'd1') => {
  const sqlite = kind === 'sqlite' ? new BetterSqlite3(':memory:') : null
  const mf = sqlite
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: ['DB'],
      })
  const d1 = mf ? await mf.getD1Database('DB') : null
  if (sqlite) await migrateContainer(sqlite)
  else await migrateD1(d1!)
  close.push(async () => {
    sqlite?.close()
    await mf?.dispose()
  })
  const db = sqlite ? createContainerDatabase(sqlite) : createD1Database(d1!)
  await db.run(
    sql`INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned','{}',${now},${now})`,
  )
  await db.run(
    sql`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Admin','Owner','administrator','[]',${now},${now}),(2,'Second','Admin','administrator','[]',${now},${now}),(3,'Member','Owned','member','[]',${now},${now})`,
  )
  await db.run(
    sql`INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(1,'owner@example.test',1,${now},${now},${now})`,
  )
  await db.run(
    sql`INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned','USD',${now},${now})`,
  )
  await db.run(
    sql`INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,created_at,updated_at) VALUES(1,1,'TEST','USD','2026-10-20','2026-11-20',${now},${now})`,
  )
  await db.run(
    sql`INSERT INTO invoice_line_items(invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at) VALUES(1,0,'Service','Owned',1,10000,10000,${now},${now})`,
  )
  await executeInvoiceLifecycleCommand(db, {
    invoiceId: 1,
    commandId: 'send',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion: 0,
    occurredAt: now,
    messageId: 1,
    eventId: 'send_event',
  })
  await recordCheckoutPayment(db, {
    invoiceId: 1,
    provider: 'stripe',
    externalAccountId: 'stripe',
    accountDisplayName: 'Stripe',
    providerTransactionId: 'pi_owned',
    amountCents: 10000,
    paidOn: '2026-10-20',
    now,
  })
  const sessions = sqlite ? createContainerSessionStore(sqlite) : createD1SessionStore(d1!)
  const session = (await sessions.issue(1)).session
  const store = createStripePaymentAlertStore(db)
  const input = {
    id: 'evt_owned',
    eventType: 'charge.refunded',
    kind: 'refund' as const,
    paymentIntentId: 'pi_owned',
    objectId: 'ch_owned',
    amountCents: 5000,
    currency: 'USD',
    providerStatus: 'partially_refunded',
    occurredAt: now,
  }
  return { db, sessions, session, store, input }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(kind + ' Stripe alert custody', () => {
    it('records once, leaves money unchanged, queues administrator notice once and repairs a lost queue delivery', async () => {
      const f = await setup(kind)
      const before = await f.db.all(sql`SELECT * FROM invoices`),
        payments = await f.db.all(sql`SELECT * FROM invoice_payments`)
      expect(await f.store.record(f.input, now)).toEqual({ kind: 'flagged', invoiceId: 1 })
      await f.store.record(f.input, now)
      expect(await f.store.list(1)).toHaveLength(1)
      expect(await f.db.all(sql`SELECT * FROM invoices`)).toEqual(before)
      expect(await f.db.all(sql`SELECT * FROM invoice_payments`)).toEqual(payments)
      const opts = {
        now,
        appUrl: 'https://owned.example.test',
        from: { email: 'sender@example.test' },
      }
      expect(await prepareStripePaymentAlertNotifications(f.db, opts)).toHaveLength(1)
      expect(await prepareStripePaymentAlertNotifications(f.db, opts)).toHaveLength(0)
      expect(
        await prepareStripePaymentAlertNotifications(f.db, {
          ...opts,
          now: new Date(Date.parse(now) + 61000).toISOString(),
        }),
      ).toHaveLength(1)
      expect(await f.db.all(sql`SELECT kind,user_id,period FROM notification_deliveries`)).toEqual([
        { kind: 'stripe_payment_alert', user_id: 1, period: 'evt_owned' },
      ])
    })
    it('reviews under live administrator authority once; later reports stay unresolved and revocation wins', async () => {
      const f = await setup(kind)
      await f.store.record(f.input, now)
      const who = { userId: 1, sessionId: String(f.session.id) }
      expect(await f.store.review(1, f.input.id, who, now)).toMatchObject({
        reviewed_by: 1,
        reviewed_at: now,
      })
      expect(await f.store.review(1, f.input.id, who, now)).toMatchObject({ reviewed_by: 1 })
      await f.store.record(
        { ...f.input, id: 'evt_later', kind: 'dispute', eventType: 'charge.dispute.created' },
        now,
      )
      expect((await f.store.list(1)).filter((r) => r.reviewed_at === null)).toHaveLength(1)
      await f.sessions.revoke(1, f.session.id)
      expect(await f.store.review(1, 'evt_later', who, now)).toBeNull()
      expect(await f.db.all(sql`SELECT * FROM stripe_payment_alert_reviews`)).toHaveLength(1)
    })
    it('refuses unknown receipts, currency mismatch and reports larger than the receipt', async () => {
      const f = await setup(kind)
      for (const patch of [
        { paymentIntentId: 'pi_unknown' },
        { amountCents: 10001 },
        { currency: 'EUR' },
      ])
        expect(await f.store.record({ ...f.input, ...patch }, now)).toMatchObject({
          kind: 'ignored',
        })
      expect(await f.store.list(1)).toEqual([])
    })
  })
