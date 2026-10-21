import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createContractorReviewStore } from '../src/contractor-review.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import { createStaffInvoicesStore } from '../src/staff-invoices.js'

const now = '2026-09-30T15:00:00.000Z',
  month = '2026-08'
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})
const fixture = async (runtime: 'sqlite' | 'd1') => {
  let db: ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>
  if (runtime === 'sqlite') {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    db = createContainerDatabase(sqlite)
    dispose = async () => {
      sqlite.close()
    }
  } else {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    })
    const binding = await mf.getD1Database('DB')
    await migrateD1(binding)
    db = createD1Database(binding)
    dispose = () => mf.dispose()
  }
  const execute = async (statement: string) => {
    await db.run(sql.raw(statement))
  }
  for (const statement of [
    `INSERT INTO organizations(name,modules,timezone,created_at,updated_at) VALUES('Org','{}','America/Costa_Rica','${now}','${now}')`,
    `INSERT INTO users(id,first_name,last_name,profile,manager_grants,is_contractor,created_at,updated_at) VALUES(1,'Admin','One','administrator','[]',0,'${now}','${now}'),(2,'Contractor','Two','member','[]',1,'${now}','${now}')`,
    `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Client','USD','${now}','${now}')`,
    `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Project','${now}','${now}')`,
    `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Task','${now}','${now}')`,
    `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'${now}','${now}')`,
    `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${now}','${now}')`,
  ])
    await execute(statement)
  const ledger = createStaffPaymentStore(db),
    invoices = createStaffInvoicesStore(db),
    review = createContractorReviewStore(db)
  const hours = () =>
    execute(
      `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at) VALUES(10,2,1,1,1,1,'2026-08-15',7200,7200,7200,1,5000,'${now}','${now}')`,
    )
  const confirm = async () => {
    const entries = (await ledger.actuals!(month, now)).people.find(
      (person) => person.user_id === 2,
    )!.entries
    const command = {
      id: 'review-1',
      user_id: 2,
      month,
      expected_version: 0,
      currency: 'USD',
      entries,
      note: 'Reviewed work with captured rates',
    }
    await ledger.confirmActuals!(command, 1, 'request-review', now)
    return command
  }
  const counts = async () => {
    const result: Record<string, number> = {}
    for (const table of [
      'staff_payment_actuals',
      'staff_payment_events',
      'staff_payment_allocations',
      'staff_advance_applications',
      'staff_invoices',
      'staff_invoice_versions',
      'payment_runs',
    ]) {
      const [row] = await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`))
      result[table] = row!.n
    }
    return result
  }
  return { db, execute, ledger, invoices, review, hours, confirm, counts }
}
for (const runtime of ['sqlite', 'd1'] as const)
  describe(`combined contractor review (${runtime})`, () => {
    it('joins invoice-before-hours, reviewed earnings and a replayed partial receipt without writing during reconciliation', async () => {
      const f = await fixture(runtime)
      await f.invoices.save(
        {
          id: 'invoice-1',
          invoice_id: null,
          expected_version: 0,
          user_id: 2,
          month,
          currency: 'USD',
          reference: 'CONTRACTOR-AUG',
          kind: 'received',
          from_review: false,
          lines: [
            {
              description: 'Project work',
              project_id: 1,
              entry_id: null,
              seconds: 7200,
              rate_cents: 5000,
            },
          ],
          document_id: null,
          reason: 'Received before hours arrived',
          acknowledge_paid_history: false,
        },
        1,
        'invoice-request',
        now,
      )
      const before = await f.counts()
      const initial = await f.review.review(month, now)
      expect(
        initial.people
          .find((person) => person.user_id === 2)!
          .currencies.find((row) => row.currency === 'USD')!.invoices[0]!.reference,
      ).toBe('CONTRACTOR-AUG')
      expect(await f.counts()).toEqual(before)
      await f.hours()
      const command = await f.confirm()
      const payment = {
        id: 'partial-1',
        user_id: 2,
        month,
        expected_version: 1,
        kind: 'payment' as const,
        currency: 'USD',
        amount_cents: 2000,
        paid_on: '2026-09-15',
        due_on: null,
        payment_id: null,
        reference: 'BANK-1',
        note: 'Confirmed bank receipt',
        source: 'wise' as const,
      }
      await f.ledger.append(payment, 1, 'receipt-request', now)
      await f.ledger.append(payment, 1, 'receipt-request', now)
      await f.ledger.confirmActuals!(command, 1, 'request-review', now)
      const afterWrites = await f.counts()
      const first = await f.review.review(month, now),
        person = first.people.find((row) => row.user_id === 2)!,
        row = person.currencies.find((row) => row.currency === 'USD')!
      expect(person.latest_review).toMatchObject({
        id: 'review-1',
        actor_id: 1,
        note: 'Reviewed work with captured rates',
      })
      expect(person.ledger_events.some((event) => event.id === 'partial-1')).toBe(true)
      expect(row).toMatchObject({
        recorded_earnings_cents: 10000,
        proposed_earnings_cents: 10000,
        paid_cents: 2000,
        available_to_pay_cents: 8000,
        remaining_after_credit_cents: 8000,
      })
      expect(row.allocation_proposals).toEqual([
        { payment_kind: 'event', payment_id: 'partial-1', amount_cents: 2000, scope: 'month' },
      ])
      expect((await f.review.review(month, '2026-09-30T15:01:00.000Z')).version).toBe(first.version)
      expect(await f.counts()).toEqual(afterWrites)
    })
    it('retains the immutable review and stops proposals when captured time changes', async () => {
      const f = await fixture(runtime)
      await f.hours()
      await f.confirm()
      const first = await f.review.review(month, now),
        counts = await f.counts()
      await f.execute('UPDATE time_entries SET cost_rate_cents=6000 WHERE id=10')
      const changed = await f.review.review(month, now),
        person = changed.people.find((row) => row.user_id === 2)!,
        row = person.currencies.find((row) => row.currency === 'USD')!
      expect(changed.version).not.toBe(first.version)
      expect(person.latest_review!.amount_cents).toBe(10000)
      expect(row).toMatchObject({
        recorded_earnings_cents: 10000,
        proposed_earnings_cents: 12000,
        proposal_blocked: true,
        allocation_proposals: [],
        credit_proposals: [],
      })
      expect(row.flags).toContain('changed_source')
      expect(await f.counts()).toEqual(counts)
    })
    it('marks unfinished/future work months as incomplete and rejects invalid months', async () => {
      const f = await fixture(runtime)
      expect((await f.review.review('2026-09', now)).completed).toBe(false)
      expect((await f.review.review('2026-12', now)).completed).toBe(false)
      await expect(f.review.review('2026-13', now)).rejects.toThrow(/valid work month/u)
    })
  })
