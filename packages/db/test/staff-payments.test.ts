import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import type { StaffPaymentCommand } from '@ezacto/core'
let database: BetterSqlite3.Database | undefined
const now = '2026-09-24T12:00:00.000Z'
const fixture = () => {
  database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.exec(`INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fixture', '{}', '${now}', '${now}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
    VALUES (1, 'Operator', 'One', 'administrator', '[]', '${now}', '${now}'),
      (2, 'Person', 'Two', 'member', '[]', '${now}', '${now}');`)
  return createStaffPaymentStore(createContainerDatabase(database))
}
const command = (overrides: Partial<StaffPaymentCommand> = {}): StaffPaymentCommand => ({
  id: 'obligation-1',
  user_id: 2,
  month: '2026-08',
  expected_version: 0,
  kind: 'amount',
  amount_cents: 10000,
  currency: 'USD',
  paid_on: null,
  due_on: '2026-09-01',
  reference: '',
  note: 'Amount agreed',
  payment_id: null,
  source: 'historical',
  ...overrides,
})
afterEach(() => database?.close())
describe('durable staff payment history', () => {
  it('replays identical requests without creating another financial entry and refuses changed payloads', async () => {
    const store = fixture()
    await store.append(command(), 1, 'request-a', now)
    await store.append(command(), 1, 'request-b', now)
    const report = await store.report('2026-08', now.slice(0, 10))
    expect(report.rows.find((row) => row.user_id === 2)).toMatchObject({
      version: 1,
      amount_cents: 10000,
      overdue: true,
    })
    expect(report.rows.find((row) => row.user_id === 2)?.events[0]).toMatchObject({
      actor_id: 1,
      request_id: 'request-a',
      recorded_at: now,
    })
    await expect(
      store.append(command({ amount_cents: 20000 }), 1, 'request-c', now),
    ).rejects.toThrow(/identifier/)
  })
  it('allows only one of two competing payments against the same remaining balance', async () => {
    const store = fixture()
    await store.append(command(), 1, 'request-a', now)
    const payment = command({
      id: 'pay-1',
      expected_version: 1,
      kind: 'payment',
      paid_on: '2026-09-20',
      due_on: null,
      reference: 'wise-1',
      source: 'wise',
    })
    const attempts = await Promise.allSettled([
      store.append(payment, 1, 'request-b', now),
      store.append({ ...payment, id: 'pay-2', reference: 'wise-2' }, 1, 'request-c', now),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(
      (await store.report('2026-08', '2026-09-24')).rows.find((row) => row.user_id === 2),
    ).toMatchObject({ paid_cents: 10000, balance_cents: 0, version: 2 })
  })
  it('keeps settlements and corrections immutable and resolves a cutoff in earlier months', async () => {
    const store = fixture()
    await store.append(
      command({
        id: 'opening',
        kind: 'opening',
        amount_cents: null,
        currency: null,
        due_on: null,
        note: 'Paid through prior provider',
      }),
      1,
      'request-a',
      now,
    )
    expect(
      (await store.report('2026-07', '2026-09-24')).rows.find((row) => row.user_id === 2),
    ).toMatchObject({ status: 'settled', amount_cents: null })
    database!.exec('UPDATE users SET is_active = 0 WHERE id = 2')
    expect(
      (await store.report('2026-07', '2026-09-24')).rows.find((row) => row.user_id === 2),
    ).toMatchObject({ status: 'settled', active: false })
    expect(() => database!.exec('DELETE FROM staff_payment_events')).toThrow(/immutable/)
    expect(() => database!.exec("UPDATE staff_payment_events SET month = '2026-09'")).toThrow(
      /immutable/,
    )
  })
})

it('[d1] persists an atomic version check and rejects a competing payment', async () => {
  const { Miniflare } = await import('miniflare')
  const { migrateD1 } = await import('../src/migrate.js')
  const { createD1Database } = await import('../src/adapters.js')
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  try {
    const d1 = await runtime.getD1Database('DB')
    await migrateD1(d1 as unknown as D1Database)
    await d1
      .prepare(
        "INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fixture', '{}', ?, ?)",
      )
      .bind(now, now)
      .run()
    await d1
      .prepare(
        "INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at) VALUES (1, 'Operator', 'One', 'administrator', '[]', ?, ?), (2, 'Person', 'Two', 'member', '[]', ?, ?)",
      )
      .bind(now, now, now, now)
      .run()
    const store = createStaffPaymentStore(createD1Database(d1 as unknown as D1Database))
    await store.append(command(), 1, 'request-a', now)
    const payment = command({
      id: 'pay-1',
      expected_version: 1,
      kind: 'payment',
      paid_on: '2026-09-20',
      due_on: null,
      reference: 'wise-1',
      source: 'wise',
    })
    const attempts = await Promise.allSettled([
      store.append(payment, 1, 'request-b', now),
      store.append({ ...payment, id: 'pay-2', reference: 'wise-2' }, 1, 'request-c', now),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(
      (await store.report('2026-08', '2026-09-24')).rows.find((row) => row.user_id === 2),
    ).toMatchObject({ paid_cents: 10000, balance_cents: 0, version: 2 })
  } finally {
    await runtime.dispose()
  }
}, 60000)
