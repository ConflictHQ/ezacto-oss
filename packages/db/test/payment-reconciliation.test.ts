import BetterSqlite3 from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'

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

const person = async (store: ReturnType<typeof fixture>) =>
  (await store.reconciliation!('2026-08', now)).people.find((p) => p.user_id === 2)

it('proposes new earnings from captured actuals without writing anything', async () => {
  const store = fixture()
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM staff_payment_events').get()
  const result = await store.reconciliation!('2026-08', now)
  expect(result).toMatchObject({ month: '2026-08', currency: 'USD', completed: true })
  expect(await person(store)).toMatchObject({
    proposed_cents: 10000,
    confirmed_cents: null,
    status: 'new',
    exceptions: [],
  })
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM staff_payment_events').get()).toEqual(before)
  expect((await store.reconciliation!('2026-09', now)).completed).toBe(false)
  await expect(store.reconciliation!('2026-13', now)).rejects.toThrow(/valid/)
})

it('flags a missing rate and excludes that entry from the proposal', async () => {
  const store = fixture()
  sqlite.exec(`UPDATE time_entries SET cost_rate_cents=NULL WHERE id=10`)
  expect(await person(store)).toMatchObject({
    proposed_cents: 0,
    status: 'attention',
    exceptions: [{ code: 'missing_rate', entry_ids: [10] }],
  })
})

it('converges once reviewed and flags a changed source afterwards', async () => {
  const store = fixture()
  const entries = (await store.actuals!('2026-08', now)).people[0]!.entries
  await store.confirmActuals!(
    {
      id: 'review-1',
      user_id: 2,
      month: '2026-08',
      expected_version: 0,
      currency: 'USD',
      entries,
      note: 'Reviewed',
    },
    1,
    'request',
    now,
  )
  expect(await person(store)).toMatchObject({
    proposed_cents: 10000,
    confirmed_cents: 10000,
    status: 'converged',
  })
  expect(await person(store)).toMatchObject({ status: 'converged' })
  sqlite.exec(`UPDATE time_entries SET cost_rate_cents=6000 WHERE id=10;
    INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at)
      VALUES(11,2,1,1,1,1,'2026-08-20',3600,3600,3600,1,6000,'${now}','${now}')`)
  expect(await person(store)).toMatchObject({
    proposed_cents: 18000,
    confirmed_cents: 10000,
    status: 'attention',
    exceptions: [{ code: 'changed_source', entry_ids: [10, 11] }],
  })
})
