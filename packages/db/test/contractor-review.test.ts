import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  migrateContainer,
  migrateD1,
  migrateContainerThrough,
  migrateD1Through,
} from '../src/migrate.js'
import { createContractorReviewStore } from '../src/contractor-review.js'
import { createContractorAcceptanceStore } from '../src/contractor-acceptance.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import { createPaymentRunsService } from '../src/payment-runs.js'
import type { AcceptContractorReview, PaymentProvider } from '@ezacto/core'
import { createStaffInvoicesStore } from '../src/staff-invoices.js'

const now = '2026-09-30T15:00:00.000Z',
  month = '2026-08'
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})
const fixture = async (runtime: 'sqlite' | 'd1', legacy = false) => {
  let upgrade!: () => Promise<void>
  let db: ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>
  if (runtime === 'sqlite') {
    const sqlite = new BetterSqlite3(':memory:')
    if (legacy) migrateContainerThrough(sqlite, '0137_staff_invoices')
    else migrateContainer(sqlite)
    upgrade = async () => {
      migrateContainer(sqlite)
    }
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
    if (legacy) await migrateD1Through(binding, '0137_staff_invoices')
    else await migrateD1(binding)
    upgrade = () => migrateD1(binding)
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
  return { db, execute, ledger, invoices, review, hours, confirm, counts, upgrade }
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

const commandFor = async (
  f: Awaited<ReturnType<typeof fixture>>,
  id = 'accept-1',
): Promise<AcceptContractorReview> => {
  const person = (await f.review.review(month, now)).people.find((p) => p.user_id === 2)!
  return {
    id,
    user_id: 2,
    month,
    currency: 'USD',
    review_version: person.review_version!,
    source_revision: person.source_revision!,
    apply_allocations: true,
    apply_credits: true,
    reason: 'Reviewed receipts and settled credit',
  }
}
const partial = async (f: Awaited<ReturnType<typeof fixture>>, id = 'partial') => {
  const row = (await f.ledger.report(month, now.slice(0, 10))).rows.find((p) => p.user_id === 2)!
  await f.ledger.append(
    {
      id,
      user_id: 2,
      month,
      expected_version: row.version,
      kind: 'payment',
      amount_cents: 2000,
      currency: 'USD',
      paid_on: '2026-09-15',
      due_on: null,
      reference: `BANK-${id}`,
      note: 'Confirmed receipt',
      payment_id: null,
      source: 'wise',
    },
    1,
    'partial-request',
    now,
  )
}
for (const runtime of ['sqlite', 'd1'] as const)
  describe(`accepted contractor reconciliation (${runtime})`, () => {
    it('atomically records receipt allocations, converges concurrent retries and preserves actor/reason', async () => {
      const f = await fixture(runtime)
      await f.hours()
      await f.confirm()
      await partial(f)
      const command = await commandFor(f),
        before = await f.counts()
      const results = await Promise.all([
        f.review.accept!(command, 1, 'first', now),
        f.review.accept!(command, 1, 'retry', now),
      ])
      expect(results[0]).toEqual(results[1])
      expect(results[0]).toMatchObject({
        state: 'completed',
        actor_id: 1,
        reason: command.reason,
        allocation_ids: ['accept-1.a.0'],
        credit_application_ids: [],
      })
      expect((await f.counts()).staff_payment_allocations).toBe(
        before.staff_payment_allocations! + 1,
      )
      expect((await f.counts()).staff_payment_events).toBe(before.staff_payment_events)
      expect(await f.review.acceptances!(month)).toEqual([results[0]])
      await expect(
        f.review.accept!({ ...command, id: 'other-accept' }, 1, 'other', now),
      ).rejects.toThrow(/changed/u)
      await expect(
        f.review.accept!({ ...command, reason: 'Changed intent' }, 1, 'other', now),
      ).rejects.toThrow(/changed/u)
      expect(
        (await f.review.review(month, now)).people.find((p) => p.user_id === 2)!.currencies[0]!
          .allocation_proposals,
      ).toEqual([])
      await expect(
        f.execute("UPDATE contractor_acceptances SET reason='changed'"),
      ).rejects.toThrow()
      await partial(f, 'second-receipt')
      const next = await commandFor(f, 'concurrent-a')
      const raced = await Promise.allSettled([
        f.review.accept!(next, 1, 'a', now),
        f.review.accept!({ ...next, id: 'concurrent-b' }, 1, 'b', now),
      ])
      expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect((await f.counts()).staff_payment_allocations).toBe(2)
    }, 60000)
    it.each(['same command', 'changed intent', 'different actor', 'different command id'])(
      'rechecks a committed acceptance after a review barrier: %s',
      async (variant) => {
        const f = await fixture(runtime)
        await f.hours()
        await f.confirm()
        await partial(f)
        const command = await commandFor(f)
        let release!: () => void
        let entered!: () => void
        const barrier = new Promise<void>((resolve) => {
          release = resolve
        })
        const reviewing = new Promise<void>((resolve) => {
          entered = resolve
        })
        const delayed = createContractorAcceptanceStore(f.db, async (...args) => {
          // Its first command lookup missed. Force the other caller to commit
          // before this caller reads the now-changed review/source versions.
          entered()
          await barrier
          return f.review.review(...args)
        })
        const delayedCommand =
          variant === 'changed intent'
            ? { ...command, reason: 'Different requested intent' }
            : variant === 'different command id'
              ? { ...command, id: 'other-command' }
              : command
        const result = delayed
          .accept(delayedCommand, variant === 'different actor' ? 2 : 1, 'delayed-retry', now)
          .then(
            (value) => ({ status: 'completed' as const, value }),
            (error: unknown) => ({ status: 'conflict' as const, error }),
          )
        await reviewing
        try {
          const accepted = await f.review.accept!(command, 1, 'winner', now)
          const afterWinner = await f.counts()
          const changed = await commandFor(f)
          expect(changed.source_revision).not.toBe(command.source_revision)
          expect(changed.review_version).not.toBe(command.review_version)
          release()
          const replayed = await result
          if (variant === 'same command') {
            expect(replayed).toEqual({ status: 'completed', value: accepted })
          } else {
            expect(replayed.status).toBe('conflict')
            if (replayed.status === 'conflict')
              expect(replayed.error).toMatchObject({ code: 'conflict' })
          }
          expect(await f.counts()).toEqual(afterWinner)
          expect(afterWinner.staff_payment_allocations).toBe(1)
          expect(afterWinner.staff_advance_applications).toBe(0)
          expect(await f.review.acceptances!(month)).toEqual([accepted])
        } finally {
          release()
          await result
        }
      },
      60000,
    )
    it('refuses stale hours and catches a source mutation after the read but before the atomic insert', async () => {
      const f = await fixture(runtime)
      await f.hours()
      await f.confirm()
      await partial(f)
      const command = await commandFor(f),
        before = await f.counts()
      // Direct insert with a stale vector exercises the DB guard, independently
      // of the service preflight. This is the read-to-write race boundary.
      await f.execute('UPDATE time_entries SET cost_rate_cents=6000 WHERE id=10')
      await expect(f.review.accept!(command, 1, 'stale', now)).rejects.toThrow(/changed/u)
      const allocation = {
        id: 'raced.a.0',
        payment_kind: 'event',
        payment_id: 'partial',
        user_id: 2,
        month,
        scope: 'month',
        project_id: null,
        entry_id: null,
        amount_cents: 2000,
        seconds: null,
        reason: command.reason,
      }
      await expect(
        Promise.resolve().then(async () => {
          await f.db
            .run(sql`INSERT INTO contractor_acceptances(id,user_id,month,currency,review_version,source_revision,command_json,allocations_json,credits_json,reason,actor_id,recorded_at,request_id)
      VALUES('raced',2,${month},'USD',${command.review_version},${command.source_revision},${JSON.stringify(command)},${JSON.stringify([allocation])},'[]',${command.reason},1,${now},'race')`)
        }),
      ).rejects.toThrow()
      expect(await f.counts()).toEqual(before)
      expect(await f.review.acceptances!(month)).toEqual([])
      await f.execute('UPDATE time_entries SET cost_rate_cents=NULL WHERE id=10')
      const missing = (await f.review.review(month, now)).people.find((p) => p.user_id === 2)!
        .currencies[0]!
      expect(missing.flags).toContain('missing_rate')
      await expect(
        f.review.accept!(await commandFor(f, 'rate-gap'), 1, 'missing-rate', now),
      ).rejects.toThrow(/changed/u)
      expect(await f.counts()).toEqual(before)
    }, 60000)
    it('does not invalidate a contractor because a different person changed their hours', async () => {
      const f = await fixture(runtime)
      await f.hours()
      await f.confirm()
      await partial(f)
      await f.execute(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,is_contractor,created_at,updated_at) VALUES(3,'Other','Person','member','[]',1,'${now}','${now}')`,
      )
      const command = await commandFor(f)
      await f.execute("UPDATE users SET first_name='Updated' WHERE id=3")
      await expect(f.review.accept!(command, 1, 'independent', now)).resolves.toMatchObject({
        state: 'completed',
      })
    }, 60000)
  })

for (const runtime of ['sqlite', 'd1'] as const)
  describe(`contractor payment lifecycle (${runtime})`, () => {
    it('covers advance → hours → invoice → partial → accepted credit → final settlement → provider refund', async () => {
      const f = await fixture(runtime),
        early = '2026-08-01T12:00:00.000Z'
      await f.execute(
        `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','456',1,'${early}','${early}','${early}','${early}')`,
      )
      const provider: PaymentProvider = {
        quote: vi.fn(async (_destination, source, target, amount) => ({
          id: 'quote',
          profile_id: '123',
          recipient_id: '456',
          recipient_name: 'Contractor Two',
          source_currency: source,
          target_currency: target,
          source_cents: amount + 50,
          target_cents: amount,
          fee_cents: 50,
          rate: 1,
          expires_at: '2026-08-01T13:00:00.000Z',
          estimated_arrival: null,
        })),
        create: vi.fn(async () => {
          throw new Error('No live funds')
        }),
        fund: vi.fn(async () => 'accepted' as const),
        read: vi.fn(async () => {
          throw new Error('No live funds')
        }),
      }
      const payments = createPaymentRunsService(f.db, provider)
      const run = await payments.preview(
        {
          id: crypto.randomUUID(),
          name: 'Advance before hours',
          source_currency: 'USD',
          scheduled_at: early,
          timezone: 'UTC',
          items: [
            {
              user_id: 2,
              month,
              expected_version: 0,
              amount_cents: 6000,
              purpose: 'advance',
              currency: 'USD',
              advance_project_id: null,
              advance_reason: 'Deposit for August work',
            },
          ],
        },
        1,
        'preview',
        early,
      )
      const item = run.items[0]!
      await payments.approve(
        run.id,
        { limits: [{ item_id: item.id, max_source_cents: 6100 }] },
        1,
        'approve',
        early,
      )
      await f.execute(
        `UPDATE payment_run_items SET state='paid',transfer_id='transfer-advance',updated_at='${early}' WHERE id='${item.id}'`,
      )
      await f.hours()
      await f.confirm()
      await f.invoices.save(
        {
          id: 'invoice',
          invoice_id: null,
          expected_version: 0,
          user_id: 2,
          month,
          currency: 'USD',
          reference: 'AUG-001',
          kind: 'received',
          from_review: true,
          lines: [],
          document_id: null,
          reason: 'Received August invoice',
          acknowledge_paid_history: false,
        },
        1,
        'invoice-request',
        now,
      )
      await partial(f)
      const command = await commandFor(f)
      const [accepted, replayed] = await Promise.all([
        f.review.accept!(command, 1, 'accept', now),
        f.review.accept!(command, 1, 'retry', now),
      ])
      expect(accepted).toEqual(replayed)
      expect(accepted.credit_application_ids).toEqual(['accept-1.c.0'])
      const current = async () =>
        (await f.review.review(month, now)).people.find((p) => p.user_id === 2)!
      const credited = (await current()).currencies.find((c) => c.currency === 'USD')!
      expect(credited).toMatchObject({
        paid_cents: 8000,
        available_to_pay_cents: 2000,
        proposed_credit_cents: 0,
        remaining_after_credit_cents: 2000,
      })
      expect(credited.invoices).toHaveLength(1)
      const row = (await f.ledger.report(month, now.slice(0, 10))).rows.find(
        (p) => p.user_id === 2,
      )!
      await f.ledger.append(
        {
          id: 'final',
          user_id: 2,
          month,
          expected_version: row.version,
          kind: 'payment',
          amount_cents: 2000,
          currency: 'USD',
          paid_on: '2026-09-30',
          due_on: null,
          reference: 'BANK-FINAL',
          note: 'Confirmed final receipt',
          payment_id: null,
          source: 'wise',
        },
        1,
        'final-request',
        now,
      )
      await f.review.accept!(await commandFor(f, 'final-links'), 1, 'final-links-request', now)
      expect(await current()).toMatchObject({ phase: 'settled' })
      expect((await current()).currencies[0]).toMatchObject({
        paid_cents: 10000,
        available_to_pay_cents: 0,
      })
      const report = await payments.report(month, month, now)
      expect(report.ledgers[0]!.rows.find((p) => p.user_id === 2)).toMatchObject({
        paid_cents: 10000,
        balance_cents: 0,
      })
      await f.execute(
        `UPDATE payment_run_items SET state='failed',provider_status='refunded',updated_at='${now}' WHERE id='${item.id}'`,
      )
      const refunded = (await current()).currencies.find((c) => c.currency === 'USD')!
      expect(refunded).toMatchObject({
        paid_cents: 4000,
        available_to_pay_cents: 6000,
        proposed_credit_cents: 0,
      })
      const refundReport = await payments.report(month, month, now)
      expect(refundReport.ledgers[0]!.rows.find((person) => person.user_id === 2)).toMatchObject({
        paid_cents: 4000,
        balance_cents: 6000,
      })
      expect(refunded.advances[0]).toMatchObject({
        returned_cents: 6000,
        applied_cents: 0,
        available_cents: 0,
      })
      expect(
        refunded.allocations.find((a) => a.id === 'advance-allocation:accept-1.c.0'),
      ).toMatchObject({ state: 'released', amount_cents: 6000 })
      expect(await f.review.accept!(command, 1, 'replay-after-refund', now)).toEqual(accepted)
      expect(await f.review.acceptances!(month)).toHaveLength(2)
      expect(provider.create).not.toHaveBeenCalled()
      expect(provider.fund).not.toHaveBeenCalled()
    }, 60000)
    it('rolls back an earlier allocation if a later credit cannot be applied', async () => {
      const f = await fixture(runtime)
      await f.hours()
      await f.confirm()
      await partial(f)
      const command = await commandFor(f),
        before = await f.counts()
      const allocation = {
        id: 'atomic.a.0',
        payment_kind: 'event',
        payment_id: 'partial',
        user_id: 2,
        month,
        scope: 'month',
        project_id: null,
        entry_id: null,
        amount_cents: 2000,
        seconds: null,
        reason: command.reason,
      }
      const credit = {
        id: 'atomic.c.0',
        advance_item_id: 'missing-credit',
        user_id: 2,
        month,
        currency: 'USD',
        scope: 'month',
        project_id: null,
        entry_id: null,
        amount_cents: 1000,
        reason: command.reason,
      }
      await expect(
        Promise.resolve().then(async () => {
          await f.db
            .run(sql`INSERT INTO contractor_acceptances(id,user_id,month,currency,review_version,source_revision,command_json,allocations_json,credits_json,reason,actor_id,recorded_at,request_id)
      VALUES('atomic',2,${month},'USD',${command.review_version},${command.source_revision},${JSON.stringify(command)},${JSON.stringify([allocation])},${JSON.stringify([credit])},${command.reason},1,${now},'atomic-request')`)
        }),
      ).rejects.toThrow()
      expect(await f.counts()).toEqual(before)
      expect(await f.review.acceptances!(month)).toEqual([])
      const unavailable = new Error('Forced database outage')
      const writeFailure = vi.spyOn(f.db, 'run').mockImplementationOnce(() => {
        throw unavailable
      })
      await expect(f.review.accept!(command, 1, 'outage', now)).rejects.toBe(unavailable)
      writeFailure.mockRestore()
      // Rollback restores the revision token too: the original review can still
      // be confirmed without a false stale-source failure.
      await expect(f.review.accept!(command, 1, 'recover', now)).resolves.toMatchObject({
        state: 'completed',
      })
    }, 60000)
  })

for (const runtime of ['sqlite', 'd1'] as const)
  it(`upgrades existing reviewed earnings and receipts without changing their history (${runtime})`, async () => {
    const f = await fixture(runtime, true)
    await f.hours()
    await f.confirm()
    await partial(f)
    const before = await f.counts(),
      ledgerBefore = await f.ledger.report(month, now.slice(0, 10))
    await f.upgrade()
    expect(await f.counts()).toEqual(before)
    expect(await f.ledger.report(month, now.slice(0, 10))).toEqual(ledgerBefore)
    const command = await commandFor(f, 'after-upgrade')
    expect(command.source_revision).toBe('[0,0,0]')
    await expect(f.review.accept!(command, 1, 'upgrade-request', now)).resolves.toMatchObject({
      state: 'completed',
      allocation_ids: ['after-upgrade.a.0'],
    })
  }, 60000)
