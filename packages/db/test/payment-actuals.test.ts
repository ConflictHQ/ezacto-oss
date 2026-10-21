import BetterSqlite3 from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import type { ConfirmPaymentActuals } from '@ezacto/core'
const now = '2026-09-30T15:00:00.000Z'
let sqlite: BetterSqlite3.Database
const seed = `INSERT INTO organizations(name,modules,timezone,created_at,updated_at) VALUES('Org','{}','America/Costa_Rica','${now}','${now}');
    INSERT INTO users(id,first_name,last_name,profile,manager_grants,is_contractor,created_at,updated_at) VALUES
      (1,'Admin','One','administrator','[]',0,'${now}','${now}'),(2,'Contractor','Two','member','[]',1,'${now}','${now}');
    INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Client','USD','${now}','${now}');
    INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Project','${now}','${now}');
    INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Task','${now}','${now}');
    INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'${now}','${now}');
    INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${now}','${now}');
    INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at)
      VALUES(10,2,1,1,1,1,'2026-08-15',7200,7200,7200,1,5000,'${now}','${now}');`
const fixture = () => {
  sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  sqlite.exec(seed)
  return createStaffPaymentStore(createContainerDatabase(sqlite))
}
afterEach(() => sqlite?.close())
const review = async (store: ReturnType<typeof fixture>): Promise<ConfirmPaymentActuals> => ({
  id: 'review-1',
  user_id: 2,
  month: '2026-08',
  expected_version: 0,
  currency: 'USD',
  entries: (await store.actuals!('2026-08', now)).people[0]!.entries,
  note: 'Reviewed captured hours',
})
it('confirms partial hours once, preserves provenance, and revises the total without adding it twice', async () => {
  const store = fixture(),
    command = await review(store)
  command.entries[0]!.selected_seconds = 3600
  await store.confirmActuals!(command, 1, 'request', now)
  await store.confirmActuals!(command, 1, 'retry', now)
  expect(
    (await store.report('2026-08', '2026-09-30')).rows.find((r) => r.user_id === 2),
  ).toMatchObject({ amount_cents: 5000, paid_cents: 0, version: 1 })
  const next = await store.actuals!('2026-08', now)
  expect(next.people[0]!.entries[0]!.selected_seconds).toBe(3600)
  const changed = {
    ...command,
    id: 'review-2',
    expected_version: 1,
    entries: command.entries.map((e) => ({ ...e, selected_seconds: 7200 })),
  }
  await store.confirmActuals!(changed, 1, 'request-2', now)
  expect(
    (await store.report('2026-08', '2026-09-30')).rows.find((r) => r.user_id === 2),
  ).toMatchObject({ amount_cents: 10000, paid_cents: 0, version: 2 })
  expect(sqlite.prepare('SELECT count(*) AS n FROM staff_payment_actuals').get()).toEqual({
    n: 2,
  })
  expect(() => sqlite.exec('DELETE FROM staff_payment_actuals')).toThrow(/immutable/)
  expect(sqlite.prepare('SELECT count(*) AS n FROM payment_runs').get()).toEqual({ n: 0 })
})
it('rejects stale source rates atomically and refuses missing selected rates', async () => {
  const store = fixture(),
    command = await review(store)
  sqlite.exec('UPDATE time_entries SET cost_rate_cents=6000 WHERE id=10')
  await expect(store.confirmActuals!(command, 1, 'changed', now)).rejects.toThrow(/changed/)
  expect(sqlite.prepare('SELECT count(*) AS n FROM staff_payment_events').get()).toEqual({
    n: 0,
  })
  sqlite.exec('UPDATE time_entries SET cost_rate_cents=NULL WHERE id=10')
  await expect(store.confirmActuals!(await review(store), 1, 'missing', now)).rejects.toThrow(
    /missing cost rates/,
  )
})
it('allows only one concurrent review and rejects reuse with a changed payload', async () => {
  const store = fixture(),
    command = await review(store)
  const outcomes = await Promise.allSettled([
    store.confirmActuals!(command, 1, 'a', now),
    store.confirmActuals!({ ...command, id: 'other' }, 1, 'b', now),
  ])
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
  await expect(
    store.confirmActuals!({ ...command, note: 'changed' }, 1, 'c', now),
  ).rejects.toThrow(/identifier/)
})
it('blocks an unfinished month using the organization timezone and an already settled month', async () => {
  const store = fixture(),
    command = await review(store)
  await expect(
    store.confirmActuals!(command, 1, 'early', '2026-09-01T01:00:00.000Z'),
  ).rejects.toThrow(/completed/)
  expect((await store.actuals!('2026-08', '2026-09-01T01:00:00.000Z')).completed).toBe(false)
  await store.append(
    {
      id: 'settlement',
      user_id: 2,
      month: '2026-08',
      expected_version: 0,
      kind: 'opening',
      amount_cents: null,
      currency: null,
      paid_on: null,
      due_on: null,
      reference: '',
      note: 'Already paid',
      payment_id: null,
      source: 'historical',
    },
    1,
    's',
    now,
  )
  await expect(
    store.confirmActuals!({ ...command, expected_version: 1 }, 1, 'already', now),
  ).rejects.toThrow(/settled/)
})
it('preserves paid money when a review lowers hours', async () => {
  const store = fixture(),
    command = await review(store)
  await store.confirmActuals!(command, 1, 'a', now)
  await store.append(
    {
      id: 'manual-payment',
      user_id: 2,
      month: '2026-08',
      expected_version: 1,
      kind: 'payment',
      amount_cents: 7500,
      currency: 'USD',
      paid_on: '2026-09-30',
      due_on: null,
      reference: 'receipt',
      note: 'Paid previously',
      payment_id: null,
      source: 'historical',
    },
    1,
    'p',
    now,
  )
  await expect(
    store.confirmActuals!(
      {
        ...command,
        id: 'reduced',
        expected_version: 2,
        entries: command.entries.map((e) => ({ ...e, selected_seconds: 3600 })),
      },
      1,
      'lower',
      now,
    ),
  ).rejects.toThrow(/changed/)
  expect(
    (await store.report('2026-08', '2026-09-30')).rows.find((r) => r.user_id === 2),
  ).toMatchObject({ amount_cents: 10000, paid_cents: 7500 })
})
it('moves a completed register without changing its physical receipt and lets either period continue independently', async () => {
  const store = fixture(),
    command = await review(store)
  await store.confirmActuals!(command, 1, 'a', now)
  await store.append(
    {
      id: 'manual-payment',
      user_id: 2,
      month: '2026-08',
      expected_version: 1,
      kind: 'payment',
      amount_cents: 10000,
      currency: 'USD',
      paid_on: '2026-09-30',
      due_on: null,
      reference: 'receipt',
      note: 'Paid previously',
      payment_id: null,
      source: 'historical',
    },
    1,
    'p',
    now,
  )
  sqlite.exec(
    `INSERT INTO staff_payment_period_moves VALUES('move',2,'2026-08','2026-07',2,1,'${now}','correction','Correct work month')`,
  )
  const corrected = (await store.report('2026-07', '2026-09-30')).rows.find(
    (r) => r.user_id === 2,
  )!
  expect(corrected).toMatchObject({
    amount_cents: 10000,
    paid_cents: 10000,
    status: 'paid',
    version: 2,
  })
  expect(corrected.events.find((e) => e.kind === 'payment')).toMatchObject({
    paid_on: '2026-09-30',
    reference: 'receipt',
    month: '2026-07',
  })
  expect(
    sqlite.prepare("SELECT month FROM staff_payment_events WHERE id='manual-payment'").get(),
  ).toEqual({ month: '2026-08' })
  expect(
    (await store.report('2026-08', '2026-09-30')).rows.find((r) => r.user_id === 2),
  ).toMatchObject({ amount_cents: null, paid_cents: 0, version: 2 })
  await store.confirmActuals!(
    { ...command, id: 'fresh', expected_version: 2 },
    1,
    'new-august',
    now,
  )
  await store.append(
    {
      ...corrected.events[0]!,
      id: 'july-note',
      source: 'historical',
      kind: 'note',
      amount_cents: null,
      currency: null,
      expected_version: 2,
      note: 'Checked',
    },
    1,
    'july',
    now,
  )
  expect(
    sqlite
      .prepare(
        'SELECT month,version,paid_cents FROM staff_payment_balances WHERE user_id=2 ORDER BY month',
      )
      .all(),
  ).toEqual([
    { month: '2026-07', version: 3, paid_cents: 10000 },
    { month: '2026-08', version: 3, paid_cents: 0 },
  ])
})

it('[d1] atomically confirms reviewed actuals and rejects changed source entries', async () => {
  const { Miniflare } = await import('miniflare')
  const { migrateD1 } = await import('../src/migrate.js')
  const { createD1Database } = await import('../src/adapters.js')
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  })
  try {
    const d1 = await runtime.getD1Database('DB')
    await migrateD1(d1 as unknown as D1Database)
    await d1.batch(
      seed
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => d1.prepare(s)),
    )
    const store = createStaffPaymentStore(createD1Database(d1 as unknown as D1Database)),
      command = await review(store)
    await store.confirmActuals!(command, 1, 'd1-review', now)
    expect(
      (await store.report('2026-08', '2026-09-30')).rows.find((r) => r.user_id === 2),
    ).toMatchObject({ amount_cents: 10000, paid_cents: 0, version: 1 })
    await d1.prepare('UPDATE time_entries SET cost_rate_cents=6000 WHERE id=10').run()
    await expect(
      store.confirmActuals!(
        { ...command, id: 'stale', expected_version: 1 },
        1,
        'd1-stale',
        now,
      ),
    ).rejects.toThrow(/changed/)
    expect(
      (await store.report('2026-08', '2026-09-30')).rows.find((r) => r.user_id === 2)?.version,
    ).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

it('preserves an explicitly agreed due date when confirming actuals', async () => {
  const store=fixture(), command=await review(store)
  await store.append({id:'agreed-amount',user_id:2,month:'2026-08',expected_version:0,kind:'amount',amount_cents:5000,currency:'USD',paid_on:null,due_on:'2026-10-15',reference:'',note:'Agreed payment date',payment_id:null,source:'historical'},1,'due-date',now)
  await store.confirmActuals!({...command,expected_version:1},1,'actuals',now)
  expect((await store.report('2026-08','2026-09-30')).rows.find(r=>r.user_id===2)).toMatchObject({amount_cents:10000,due_on:'2026-10-15'})
})
