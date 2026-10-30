import { createContainerEmailLogStore, createD1EmailLogStore } from '../src/email-log.js'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
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
const setup = async (kind: 'sqlite' | 'd1', paid = true) => {
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
    sql`INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(2,'owner@example.test',1,${now},${now},${now})`,
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
  const pay = () =>
    recordCheckoutPayment(db, {
      invoiceId: 1,
      provider: 'stripe',
      externalAccountId: 'stripe',
      accountDisplayName: 'Stripe',
      providerTransactionId: 'pi_owned',
      amountCents: 10000,
      paidOn: '2026-10-20',
      now,
    })
  if (paid) await pay()
  const emailLog = sqlite ? createContainerEmailLogStore(sqlite) : createD1EmailLogStore(d1!)
  const sessions = sqlite ? createContainerSessionStore(sqlite) : createD1SessionStore(d1!)
  const session = (await sessions.issue(2)).session
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
  return {
    db,
    sessions,
    session,
    store,
    input,
    pay,
    emailLog,
    expiredSession: async () => {
      const stamp = new Date(Date.now() - 60000).toISOString()
      const opts = { now: () => stamp, idleTtlMs: 1000, absoluteTtlMs: 3600000, touchIntervalMs: 0 }
      const past = sqlite
        ? createContainerSessionStore(sqlite, opts)
        : createD1SessionStore(d1!, opts)
      return { session: (await past.issue(2)).session, stamp }
    },
  }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(kind + ' Stripe alert custody', () => {
    it('records once, leaves money unchanged, queues administrator notice once and repairs a lost queue delivery', async () => {
      const f = await setup(kind)
      const before = await f.db.all(sql`SELECT * FROM invoices`),
        payments = await f.db.all(sql`SELECT * FROM invoice_payments`)
      expect(
        await Promise.all([
          f.store.record(f.input, now),
          f.store.record(f.input, now),
          f.store.record(f.input, now),
        ]),
      ).toEqual(Array(3).fill({ kind: 'flagged', invoiceId: 1 }))
      expect(await f.store.list(1)).toHaveLength(1)
      expect(await f.db.all(sql`SELECT * FROM invoices`)).toEqual(before)
      expect(await f.db.all(sql`SELECT * FROM invoice_payments`)).toEqual(payments)
      const opts = {
        now,
        appUrl: 'https://owned.example.test',
        from: { email: 'sender@example.test' },
      }
      const notices = await prepareStripePaymentAlertNotifications(f.db, opts)
      expect(notices).toHaveLength(1)
      // Invoice number TEST intentionally differs from primary key 1.
      expect(notices[0]?.text).toContain('https://owned.example.test/invoices/by-id/1')
      expect(await prepareStripePaymentAlertNotifications(f.db, opts)).toHaveLength(0)
      expect(
        await prepareStripePaymentAlertNotifications(f.db, {
          ...opts,
          now: new Date(Date.parse(now) + 61000).toISOString(),
        }),
      ).toHaveLength(1)
      expect(await f.db.all(sql`SELECT kind,user_id,period FROM notification_deliveries`)).toEqual([
        { kind: 'stripe_payment_alert', user_id: 2, period: 'evt_owned' },
      ])
    })
    it('reviews under live administrator authority once; later reports stay unresolved and revocation wins', async () => {
      const f = await setup(kind)
      await f.store.record(f.input, now)
      const who = { userId: 2, sessionId: String(f.session.id) }
      expect(await f.store.review(1, f.input.id, who, now)).toMatchObject({
        reviewed_by: 2,
        reviewed_at: now,
      })
      expect(await f.store.review(1, f.input.id, who, now)).toMatchObject({ reviewed_by: 2 })
      await f.store.record(
        { ...f.input, id: 'evt_later', kind: 'dispute', eventType: 'charge.dispute.created' },
        now,
      )
      expect((await f.store.list(1)).filter((r) => r.reviewed_at === null)).toHaveLength(1)
      await f.sessions.revoke(2, f.session.id)
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
    it('retains an early report and reconciles after the original receipt arrives', async () => {
      const f = await setup(kind, false)
      await f.store.record(f.input, now)
      expect(await f.store.list(1)).toEqual([])
      expect(await f.db.all(sql`SELECT id FROM stripe_payment_alert_inbox`)).toEqual([
        { id: f.input.id },
      ])
      await f.pay()
      await f.store.processDue(now)
      expect(await f.store.list(1)).toHaveLength(1)
      expect(await f.db.all(sql`SELECT id FROM stripe_payment_alert_inbox`)).toEqual([])
    })
    it('a recipient demotion during notification selection prevents durable private mail', async () => {
      const f = await setup(kind)
      await f.store.record(f.input, now)
      let changed = false
      const wrapped = new Proxy(f.db, {
        get(target, prop, receiver) {
          if (prop === 'all')
            return async (query: Parameters<typeof f.db.all>[0]) => {
              const result = await target.all(query)
              if (
                !changed &&
                (typeof query === 'string'
                  ? query
                  : new SQLiteSyncDialect().sqlToQuery(query.getSQL()).sql
                ).includes('SELECT alert.id')
              ) {
                changed = true
                await target.run(sql`UPDATE users SET profile='member' WHERE id=2`)
              }
              return result
            }
          return Reflect.get(target, prop, receiver)
        },
      })
      expect(
        await prepareStripePaymentAlertNotifications(wrapped, {
          now,
          appUrl: 'https://owned.example.test',
          from: { email: 'sender@example.test' },
        }),
      ).toEqual([])
      expect(
        await f.db.all(sql`SELECT id FROM email_log WHERE template='stripe-payment-alert'`),
      ).toEqual([])
    })
    it.each(['demotion', 'email replacement'])(
      'a queued notice cannot claim a provider attempt after %s',
      async (change) => {
        const f = await setup(kind)
        await f.store.record(f.input, now)
        const notices = await prepareStripePaymentAlertNotifications(f.db, {
          now,
          appUrl: 'https://owned.example.test',
          from: { email: 'sender@example.test' },
        })
        if (change === 'demotion') await f.db.run(sql`UPDATE users SET profile='member' WHERE id=2`)
        else {
          await f.db.run(
            sql`UPDATE user_emails SET is_primary=0,invalidated_at=${now} WHERE user_id=2`,
          )
          await f.db.run(
            sql`INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(2,'new@example.test',1,${now},${now},${now})`,
          )
        }
        expect(
          await f.emailLog.claimAttempt(notices[0]!.deliveryId, 'owned', 'attempt', 60),
        ).toBeNull()
        expect(await f.emailLog.get(notices[0]!.deliveryId)).toMatchObject({
          status: 'failed',
          attemptCount: 0,
          failureReason: 'recipient_scope_changed',
        })
      },
    )
    it('uses current database time when a session expires before review reaches the write', async () => {
      const f = await setup(kind)
      await f.store.record(f.input, now)
      const expired = await f.expiredSession()
      const old = expired.stamp
      expect(
        await f.store.review(
          1,
          f.input.id,
          { userId: 2, sessionId: String(expired.session.id) },
          new Date(Date.parse(old) - 1000).toISOString(),
        ),
      ).toBeNull()
    })
  })
