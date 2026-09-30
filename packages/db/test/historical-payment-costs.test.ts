import BetterSqlite3 from 'better-sqlite3'
import { expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import { createReportRepository } from '../src/reports.js'
const now = '2026-09-30T15:00:00.000Z'
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

for (const runtime of ['sqlite', 'd1'] as const) {
  it(`${runtime}: values settled months from contractor costs without creating payments or payable balances`, async () => {
    const sqlite = runtime === 'sqlite' ? new BetterSqlite3(':memory:') : null
    const { Miniflare } = await import('miniflare')
    const worker =
      runtime === 'd1'
        ? new Miniflare({
            modules: true,
            script: 'export default {fetch(){return new Response("ok")}}',
            d1Databases: ['DB'],
          })
        : null
    const d1 = worker ? await worker.getD1Database('DB') : null
    try {
      if (sqlite) migrateContainer(sqlite)
      else await migrateD1(d1! as unknown as D1Database)
      const execute = async (sql: string) => {
        if (sqlite) sqlite.exec(sql)
        else
          for (const statement of sql
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean))
            await d1!.prepare(statement).run()
      }
      await execute(seed)
      const db = sqlite
        ? createContainerDatabase(sqlite)
        : createD1Database(d1! as unknown as D1Database)
      const store = createStaffPaymentStore(db)
      const read = async (month = '2026-08') =>
        (await store.report(month, '2026-09-30')).rows.find((r) => r.user_id === 2)!
      await store.append(
        {
          id: 'cutoff',
          user_id: 2,
          month: '2026-08',
          expected_version: 0,
          kind: 'opening',
          amount_cents: null,
          currency: null,
          paid_on: null,
          due_on: null,
          reference: '',
          note: 'Confirmed settled through August',
          payment_id: null,
          source: 'historical',
        },
        1,
        'cutoff-request',
        now,
      )
      await execute('UPDATE time_entries SET rounded_seconds=1, cost_rate_cents=1800 WHERE id=10')
      // Per-entry half-up rounding (two half-cent entries = two cents), not aggregate rounding.
      await execute(
        `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at) VALUES(11,2,1,1,1,1,'2026-08-16',1,1,1,1,1800,'${now}','${now}')`,
      )
      const costs = await createReportRepository(db).contractorCost({
        from: '2026-08-01',
        to: '2026-08-31',
      })
      expect(costs.rows.find((r) => r.userId === 2)?.costCents).toBe(2)
      expect(await read()).toMatchObject({
        status: 'settled',
        amount_cents: 2,
        amount_basis: 'contractor_cost',
        currency: 'USD',
        paid_cents: 0,
        balance_cents: null,
        available_cents: null,
        version: 1,
      })
      expect((await read()).events).toHaveLength(1)
      expect(await read('2026-07')).toMatchObject({
        status: 'settled',
        amount_cents: null,
        amount_basis: 'ledger',
      })
      expect(await read('2026-09')).toMatchObject({
        status: 'in_progress',
        amount_cents: null,
        paid_cents: 0,
      })
      await execute('UPDATE time_entries SET cost_rate_cents=NULL WHERE id=11')
      expect(await read()).toMatchObject({ status: 'settled', amount_cents: null, currency: null })
      await execute('UPDATE time_entries SET cost_rate_cents=1800, rounded_seconds=-1 WHERE id=11')
      expect(await read()).toMatchObject({ amount_cents: 0, amount_basis: 'contractor_cost' })
      await execute('UPDATE users SET is_contractor=0 WHERE id=2')
      expect(await read()).toMatchObject({ amount_cents: null })
      await execute('UPDATE users SET is_contractor=1 WHERE id=2')
      await execute(
        "UPDATE time_entries SET spent_date='2026-07-15', rounded_seconds=3600 WHERE id=11",
      )
      expect(await read('2026-07')).toMatchObject({
        status: 'settled',
        amount_cents: 1800,
        amount_basis: 'contractor_cost',
        paid_cents: 0,
      })
      expect(await read()).toMatchObject({ amount_cents: 1, amount_basis: 'contractor_cost' })
      await store.append(
        {
          id: 'reopen',
          user_id: 2,
          month: '2026-08',
          expected_version: 1,
          kind: 'reopen',
          amount_cents: null,
          currency: null,
          paid_on: null,
          due_on: null,
          reference: '',
          note: 'Review exact historical records',
          payment_id: null,
          source: 'historical',
        },
        1,
        'reopen-request',
        now,
      )
      expect(await read()).toMatchObject({
        status: 'pending',
        amount_cents: null,
        amount_basis: 'ledger',
        version: 2,
      })
      await store.append(
        {
          id: 'amount',
          user_id: 2,
          month: '2026-08',
          expected_version: 2,
          kind: 'amount',
          amount_cents: 105000,
          currency: 'USD',
          paid_on: null,
          due_on: null,
          reference: '',
          note: 'Exact agreed earnings',
          payment_id: null,
          source: 'historical',
        },
        1,
        'amount-request',
        now,
      )
      await store.append(
        {
          id: 'receipt',
          user_id: 2,
          month: '2026-08',
          expected_version: 3,
          kind: 'payment',
          amount_cents: 105000,
          currency: 'USD',
          paid_on: '2026-09-30',
          due_on: null,
          reference: 'wise-reference',
          note: 'Confirmed Wise receipt',
          payment_id: null,
          source: 'wise',
        },
        1,
        'receipt-request',
        now,
      )
      expect(await read()).toMatchObject({
        status: 'paid',
        amount_cents: 105000,
        amount_basis: 'ledger',
        paid_cents: 105000,
        balance_cents: 0,
      })
      expect((await read()).events.at(-1)).toMatchObject({
        paid_on: '2026-09-30',
        reference: 'wise-reference',
      })
    } finally {
      sqlite?.close()
      await worker?.dispose()
    }
  }, 60000)
}
