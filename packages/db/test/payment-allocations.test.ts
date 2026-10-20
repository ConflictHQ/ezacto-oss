// Provenance: ezacto-pvt #899. Payment allocation on SQLite (container) and D1
// (Miniflare): the same migration and triggers must hold the same invariants.
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import type { AllocatePayment, StaffPaymentStore } from '@ezacto/core'

const now = '2026-09-30T15:00:00.000Z'
const statements = [
  `INSERT INTO organizations(name,modules,timezone,created_at,updated_at) VALUES('Org','{}','America/Costa_Rica','${now}','${now}')`,
  `INSERT INTO users(id,first_name,last_name,profile,manager_grants,is_contractor,created_at,updated_at) VALUES
    (1,'Admin','One','administrator','[]',0,'${now}','${now}'),(2,'Contractor','Two','member','[]',1,'${now}','${now}'),
    (3,'Contractor','Three','member','[]',1,'${now}','${now}')`,
  `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Client','USD','${now}','${now}')`,
  `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Alpha','${now}','${now}'),(2,1,'Beta','${now}','${now}')`,
  `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Task','${now}','${now}')`,
  `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'${now}','${now}'),(2,2,2,'${now}','${now}'),(3,1,3,'${now}','${now}')`,
  `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${now}','${now}'),(2,2,1,1,'${now}','${now}')`,
  `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at) VALUES
    (10,2,1,1,1,1,'2026-08-15',7200,7200,7200,1,5000,'${now}','${now}'),
    (11,2,1,1,1,1,'2026-08-16',3600,3600,3600,1,5000,'${now}','${now}'),
    (12,2,2,1,2,2,'2026-08-17',3600,3600,3600,1,6000,'${now}','${now}'),
    (20,3,1,1,3,1,'2026-08-15',3600,3600,3600,1,4000,'${now}','${now}')`,
  `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','456',1,'${now}','${now}','${now}','${now}')`,
]

interface Fixture {
  store: StaffPaymentStore
  exec: (query: string) => Promise<void>
  rows: (query: string) => Promise<Record<string, unknown>[]>
  dispose: () => Promise<void>
}
let current: Fixture | undefined
afterEach(async () => {
  await current?.dispose()
  current = undefined
})

const build = async (runtime: 'sqlite' | 'd1'): Promise<Fixture> => {
  if (runtime === 'sqlite') {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    return {
      store: createStaffPaymentStore(createContainerDatabase(sqlite)),
      exec: async (query) => void sqlite.exec(query),
      rows: async (query) => sqlite.prepare(query).all() as Record<string, unknown>[],
      dispose: async () => void sqlite.close(),
    }
  }
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const binding = await mf.getD1Database('DB')
  await migrateD1(binding)
  return {
    store: createStaffPaymentStore(createD1Database(binding) as never),
    exec: async (query) => void (await binding.prepare(query).run()),
    rows: async (query) => (await binding.prepare(query).all<Record<string, unknown>>()).results,
    dispose: async () => mf.dispose(),
  }
}

let version = 0
const ready = async (runtime: 'sqlite' | 'd1') => {
  const f = (current = await build(runtime))
  for (const statement of statements) await f.exec(statement)
  const entries = (await f.store.actuals!('2026-08', now)).people.find((p) => p.user_id === 2)!.entries
  await f.store.confirmActuals!(
    { id: 'review-1', user_id: 2, month: '2026-08', expected_version: 0, currency: 'USD', entries, note: 'Reviewed' },
    1,
    'review',
    now,
  )
  version = 1
  const pay = async (id: string, cents: number) => {
    await f.store.append(
      { id, user_id: 2, month: '2026-08', expected_version: version, kind: 'payment', amount_cents: cents, currency: 'USD', paid_on: '2026-09-30', due_on: null, reference: id, note: 'Paid', payment_id: null, source: 'historical' },
      1,
      id,
      now,
    )
    version += 1
  }
  const allocate = (over: Partial<AllocatePayment> & { id: string; payment_id: string }) =>
    f.store.allocatePayment!(
      { payment_kind: 'event', user_id: 2, month: '2026-08', scope: 'entry', project_id: 1, entry_id: 10, seconds: null, amount_cents: null, reason: 'Reconciled', ...over },
      1,
      `req-${over.id}`,
      now,
    )
  return { f, pay, allocate }
}
const person = async (f: Fixture) =>
  (await f.store.allocationReport!('2026-08')).people.find((p) => p.user_id === 2)!

describe.each(['sqlite', 'd1'] as const)('payment allocations on %s', (runtime) => {
  it('leaves existing payments unallocated and reconciles the month without inventing hours', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 12000)
    let report = await person(f)
    expect(report).toMatchObject({ earned_cents: 21000, paid_cents: 12000, allocated_applied_cents: 0, remaining_cents: 9000 })
    expect(report.unallocated_payments).toEqual([
      expect.objectContaining({ payment_id: 'p1', unallocated_cents: 12000, state: 'applied' }),
    ])
    await allocate({ id: 'a1', payment_id: 'p1', scope: 'month', project_id: null, entry_id: null, amount_cents: 12000 })
    report = await person(f)
    expect(report).toMatchObject({ earned_cents: 21000, paid_cents: 12000, allocated_applied_cents: 12000, unallocated_payments: [] })
    expect(report.projects.flatMap((p) => p.entries.map((e) => e.applied_seconds))).toEqual([0, 0, 0])
    expect((await f.store.report('2026-08', '2026-09-30')).rows.find((r) => r.user_id === 2)).toMatchObject({ amount_cents: 21000, paid_cents: 12000 })
  })

  it('previews and records partial hours at the captured rate, the last hours taking the remainder', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 12000)
    const hours = { id: 'h1', payment_id: 'p1', seconds: 3600 }
    await expect(f.store.previewAllocation!({ payment_kind: 'event', user_id: 2, month: '2026-08', scope: 'entry', project_id: 1, entry_id: 10, amount_cents: null, reason: 'x', ...hours })).resolves.toMatchObject({
      amount_cents: 5000,
      rate_cents: 5000,
      payment_remaining_cents: 12000,
      earning_cents: 10000,
      earning_remaining_cents: 10000,
      earning_remaining_seconds: 7200,
    })
    await allocate(hours)
    await allocate({ ...hours, id: 'h2' })
    const entry = (await person(f)).projects[0]!.entries.find((e) => e.entry_id === 10)!
    expect(entry).toMatchObject({ applied_cents: 10000, applied_seconds: 7200, remaining_cents: 0, remaining_seconds: 0, source_changed: false })
    await expect(allocate({ ...hours, id: 'h3' })).rejects.toThrow(/exceed/)
  })

  it('allocates a partial amount to a project and to an entry with a reason', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 12000)
    await allocate({ id: 'proj', payment_id: 'p1', scope: 'project', project_id: 2, entry_id: null, amount_cents: 2500 })
    await allocate({ id: 'ent', payment_id: 'p1', entry_id: 11, amount_cents: 1000, reason: 'Advance on the second day' })
    const report = await person(f)
    expect(report.projects.find((p) => p.project_id === 2)).toMatchObject({ earned_cents: 6000, applied_cents: 2500, remaining_cents: 3500 })
    expect(report.projects.find((p) => p.project_id === 1)).toMatchObject({ earned_cents: 15000, applied_cents: 1000 })
    await expect(allocate({ id: 'over', payment_id: 'p1', scope: 'project', project_id: 2, entry_id: null, amount_cents: 3501 })).rejects.toThrow(/exceeds/)
    await expect(allocate({ id: 'noreason', payment_id: 'p1', amount_cents: 1, reason: '  ' })).rejects.toThrow(/Explain/)
  })

  it('repeats a command safely and refuses a reused identifier with a different payload', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 12000)
    await allocate({ id: 'a1', payment_id: 'p1', seconds: 3600 })
    await allocate({ id: 'a1', payment_id: 'p1', seconds: 3600 })
    expect(await f.rows('SELECT count(*) AS n FROM staff_payment_allocations')).toEqual([{ n: 1 }])
    await expect(allocate({ id: 'a1', payment_id: 'p1', seconds: 1800 })).rejects.toThrow(/identifier/)
  })

  it('lets only one of two concurrent workers spend the same funds or the same hours', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 7000)
    await pay('p2', 7000)
    await pay('p3', 7000)
    const month = { scope: 'month' as const, project_id: null, entry_id: null }
    const sameFunds = await Promise.allSettled([
      allocate({ id: 'f1', payment_id: 'p1', ...month, amount_cents: 5000 }),
      allocate({ id: 'f2', payment_id: 'p1', ...month, amount_cents: 5000 }),
    ])
    expect(sameFunds.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const sameHours = await Promise.allSettled([
      allocate({ id: 'g1', payment_id: 'p2', entry_id: 12, project_id: 2, seconds: 3600 }),
      allocate({ id: 'g2', payment_id: 'p3', entry_id: 12, project_id: 2, seconds: 3600 }),
    ])
    expect(sameHours.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const same = await Promise.allSettled([
      allocate({ id: 'dup', payment_id: 'p1', ...month, amount_cents: 500 }),
      allocate({ id: 'dup', payment_id: 'p1', ...month, amount_cents: 500 }),
    ])
    expect(same.every((o) => o.status === 'fulfilled')).toBe(true)
    expect(await f.rows(`SELECT count(*) AS n FROM staff_payment_allocations WHERE id IN ('dup','g1','g2','f1','f2')`)).toEqual([{ n: 3 }])
  })

  it('enforces person, month, currency and capacity in the database for any writer', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 12000)
    await expect(allocate({ id: 'x', payment_id: 'p1', user_id: 3, month: '2026-08', amount_cents: 100, scope: 'month', project_id: null, entry_id: null })).rejects.toThrow()
    await expect(allocate({ id: 'y', payment_id: 'missing', amount_cents: 100 })).rejects.toThrow(/Choose a recorded/)
    await expect(allocate({ id: 'z', payment_id: 'p1', entry_id: 20, seconds: 3600 })).rejects.toThrow(/time entry/)
    const insert = (id: string, extra: string) =>
      f.exec(`INSERT INTO staff_payment_allocations(id,payment_kind,payment_id,user_id,month,currency,scope,project_id,entry_id,seconds,rate_cents,amount_cents,command_json,reason,actor_id,recorded_at,request_id)
        VALUES('${id}','event','p1',2,'2026-08',${extra},'{}','raw',1,'${now}','r')`)
    await expect(insert('c1', `'EUR','month',NULL,NULL,NULL,NULL,100`)).rejects.toThrow(/live payment/)
    await expect(insert('c2', `'USD','month',NULL,NULL,NULL,NULL,12001`)).rejects.toThrow(/exceeds the payment/)
    await expect(insert('c3', `'USD','entry',1,10,3600,5000,5001`)).rejects.toThrow(/value of its hours/)
    await f.exec(`INSERT INTO staff_payment_allocations(id,payment_kind,payment_id,user_id,month,currency,scope,amount_cents,command_json,reason,actor_id,recorded_at,request_id) VALUES('ok','event','p1',2,'2026-08','USD','month',100,'{}','raw',1,'${now}','r')`)
    await expect(f.exec(`UPDATE staff_payment_allocations SET amount_cents=1`)).rejects.toThrow(/immutable/)
  })

  it('keeps history: reversal restores capacity, a void releases, and rows are never deleted', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 12000)
    await allocate({ id: 'a1', payment_id: 'p1', seconds: 7200 })
    await expect(allocate({ id: 'a2', payment_id: 'p1', entry_id: 11, seconds: 3600, amount_cents: 2000 })).resolves.toBeUndefined()
    const reverse = (id: string, allocation_id: string) => f.store.reverseAllocation!({ id, allocation_id, reason: 'Wrong entry' }, 1, 'rev', now)
    await reverse('r1', 'a1')
    await reverse('r1', 'a1')
    await expect(reverse('r2', 'a1')).rejects.toThrow(/already reversed/)
    await expect(reverse('r3', 'nope')).rejects.toThrow(/existing allocation/)
    expect((await person(f)).projects[0]!.entries.find((e) => e.entry_id === 10)).toMatchObject({ applied_cents: 0, remaining_seconds: 7200 })
    await allocate({ id: 'a3', payment_id: 'p1', seconds: 3600 })
    // A void of the payment itself releases what it funded.
    await f.store.append(
      { id: 'void1', user_id: 2, month: '2026-08', expected_version: version, kind: 'void', amount_cents: null, currency: null, paid_on: null, due_on: null, reference: '', note: 'Refunded', payment_id: 'p1', source: 'historical' },
      1,
      'void',
      now,
    )
    const report = await person(f)
    expect(report).toMatchObject({ paid_cents: 0, allocated_applied_cents: 0 })
    expect(report.allocations.map((a) => [a.id, a.state])).toEqual([['a1', 'reversed'], ['a2', 'released'], ['a3', 'released']])
    await expect(f.exec('DELETE FROM staff_payment_allocations')).rejects.toThrow(/immutable/)
    await expect(f.exec('DELETE FROM staff_payment_allocation_reversals')).rejects.toThrow(/immutable/)
  })

  it('reserves a scheduled payment, applies it once settled and releases it when it fails or is cancelled', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 1000)
    const schedule = async (id: string, cents: number) => {
      const balance = (await f.rows(`SELECT version FROM staff_payment_balances WHERE user_id=2 AND month='2026-08'`))[0]!.version
      const item = { id, user_id: 2, month: '2026-08', expected_version: balance, name: 'Contractor Two', amount_cents: cents, currency: 'USD', destination: { id: 1 }, quote: { source_cents: cents + 50 } }
      await f.exec(`INSERT INTO payment_runs(id,command_json,name,source_currency,scheduled_at,timezone,state,actor_id,created_at,request_id)
        VALUES('run-${id}','${JSON.stringify({ items: [item] })}','Run','USD','${now}','UTC','draft',1,'${now}','r')`)
      await f.exec(`UPDATE payment_runs SET state='approved',approved_by=1,approved_at='${now}',
        approval_json='${JSON.stringify({ limits: [{ item_id: id, max_source_cents: cents + 50 }] })}' WHERE id='run-${id}'`)
    }
    await schedule('item1', 4000)
    await expect(allocate({ id: 'bad', payment_id: 'item1', amount_cents: 100 })).rejects.toThrow(/Choose a recorded/)
    await allocate({ id: 'r1', payment_kind: 'run_item', payment_id: 'item1', seconds: 3600, amount_cents: 4000, scope: 'entry', entry_id: 10 })
    expect((await person(f)).allocations[0]).toMatchObject({ state: 'reserved', amount_cents: 4000 })
    expect((await person(f)).projects[0]!.entries.find((e) => e.entry_id === 10)).toMatchObject({ reserved_cents: 4000, applied_cents: 0 })
    await f.exec(`UPDATE payment_run_items SET state='paid',transfer_id='t1',updated_at='${now}' WHERE id='item1'`)
    expect((await person(f)).allocations[0]).toMatchObject({ state: 'applied' })
    await expect(allocate({ id: 'settled', payment_id: 'run-payment:item1', amount_cents: 1 })).rejects.toThrow(/payment run item/)
    await f.exec(`UPDATE payment_run_items SET state='failed',updated_at='${now}' WHERE id='item1'`)
    expect((await person(f)).allocations[0]).toMatchObject({ state: 'released' })
    await schedule('item2', 2000)
    await allocate({ id: 'r2', payment_kind: 'run_item', payment_id: 'item2', scope: 'month', project_id: null, entry_id: null, amount_cents: 2000 })
    await f.exec(`UPDATE payment_run_items SET state='cancelled',updated_at='${now}' WHERE id='item2'`)
    expect((await person(f)).allocations.map((a) => a.state)).toEqual(['released', 'released'])
  })

  it('restores the allocation when a settled run item is refunded and reversed, without deleting rows', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 1000)
    await pay('p2', 12000)
    const balance = (await f.rows(`SELECT version FROM staff_payment_balances WHERE user_id=2 AND month='2026-08'`))[0]!.version
    const item = { id: 'item1', user_id: 2, month: '2026-08', expected_version: balance, name: 'Contractor Two', amount_cents: 4000, currency: 'USD', destination: { id: 1 }, quote: { source_cents: 4050 } }
    await f.exec(`INSERT INTO payment_runs(id,command_json,name,source_currency,scheduled_at,timezone,state,actor_id,created_at,request_id)
      VALUES('run-1','${JSON.stringify({ items: [item] })}','Run','USD','${now}','UTC','draft',1,'${now}','r')`)
    await f.exec(`UPDATE payment_runs SET state='approved',approved_by=1,approved_at='${now}',
      approval_json='${JSON.stringify({ limits: [{ item_id: 'item1', max_source_cents: 4050 }] })}' WHERE id='run-1'`)
    await allocate({ id: 'r1', payment_kind: 'run_item', payment_id: 'item1', seconds: 3600, amount_cents: 4000, scope: 'entry', entry_id: 10 })
    await f.exec(`UPDATE payment_run_items SET state='paid',transfer_id='t1',updated_at='${now}' WHERE id='item1'`)
    const entry = async () => (await person(f)).projects[0]!.entries.find((e) => e.entry_id === 10)!
    expect((await person(f)).allocations[0]).toMatchObject({ state: 'applied' })
    expect(await entry()).toMatchObject({ applied_cents: 4000 })
    // The provider refunds the transfer: the run item fails and the allocation is released.
    await f.exec(`UPDATE payment_run_items SET state='failed',updated_at='${now}' WHERE id='item1'`)
    expect((await person(f)).allocations[0]).toMatchObject({ state: 'released' })
    await f.store.reverseAllocation!({ id: 'rev1', allocation_id: 'r1', reason: 'Transfer refunded' }, 1, 'rev', now)
    expect((await person(f)).allocations[0]).toMatchObject({ id: 'r1', state: 'reversed', amount_cents: 4000 })
    expect(await entry()).toMatchObject({ applied_cents: 0, reserved_cents: 0, remaining_cents: 10000, remaining_seconds: 7200 })
    expect(await f.rows('SELECT count(*) AS n FROM staff_payment_allocations')).toEqual([{ n: 1 }])
    expect(await f.rows('SELECT allocation_id,reason FROM staff_payment_allocation_reversals')).toEqual([{ allocation_id: 'r1', reason: 'Transfer refunded' }])
    await allocate({ id: 'again', payment_id: 'p2', seconds: 7200 })
    expect(await entry()).toMatchObject({ applied_cents: 10000, remaining_seconds: 0 })
  })

  it('flags edited source hours for review, keeps the snapshot and blocks a work-month move while allocated', async () => {
    const { f, pay, allocate } = await ready(runtime)
    await pay('p1', 12000)
    await allocate({ id: 'a1', payment_id: 'p1', seconds: 3600 })
    await f.exec(`UPDATE time_entries SET rounded_seconds=1800,cost_rate_cents=9000 WHERE id=10`)
    const report = await person(f)
    expect(report.projects[0]!.entries.find((e) => e.entry_id === 10)).toMatchObject({ source_changed: true, applied_cents: 5000 })
    expect(await f.rows(`SELECT rate_cents,json_extract(snapshot_json,'$.rounded_seconds') AS rounded FROM staff_payment_allocations`)).toEqual([{ rate_cents: 5000, rounded: 7200 }])
    await expect(
      f.exec(`INSERT INTO staff_payment_period_moves(id,user_id,from_month,to_month,through_version,actor_id,recorded_at,request_id,note) VALUES('m1',2,'2026-08','2026-07',${version},1,'${now}','r','fix')`),
    ).rejects.toThrow(/reverse the payment allocations/)
  })
})
