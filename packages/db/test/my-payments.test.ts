// Provenance: ezacto-pvt #100. The own-subject payment read model, run against a
// real migrated database on both runtimes (container SQLite and Worker D1).
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaymentProvider, PaymentQuote, StaffPaymentCommand } from '@ezacto/core'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createMyPaymentsStore } from '../src/my-payments.js'
import { createPaymentRunsService } from '../src/payment-runs.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'

const now = '2026-10-19T12:00:00.000Z'
const today = '2026-10-19'
const quote: PaymentQuote = {
  id: 'quote-1',
  profile_id: '123',
  recipient_id: '456',
  recipient_name: 'Person',
  source_currency: 'USD',
  target_currency: 'USD',
  source_cents: 5050,
  target_cents: 5000,
  fee_cents: 50,
  rate: 1,
  expires_at: '2026-10-19T13:00:00.000Z',
  estimated_arrival: null,
}
const provider: PaymentProvider = {
  quote: vi.fn(async () => ({ ...quote })),
  create: vi.fn(),
  fund: vi.fn(),
  read: vi.fn(),
} as unknown as PaymentProvider

const seed = [
  `INSERT INTO organizations(name,modules,timezone,created_at,updated_at) VALUES('Org','{}','America/Costa_Rica','${now}','${now}')`,
  `INSERT INTO users(id,first_name,last_name,profile,manager_grants,is_contractor,created_at,updated_at) VALUES
    (1,'Admin','One','administrator','[]',0,'${now}','${now}'),
    (2,'Contractor','Two','member','[]',1,'${now}','${now}'),
    (3,'Holder','Three','member','[]',0,'${now}','${now}'),
    (4,'Plain','Four','member','[]',0,'${now}','${now}'),
    (5,'Contractor','Five','project_manager','[]',1,'${now}','${now}')`,
  `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES
    (1,2,'wise','456',1,'${now}','${now}','${now}','${now}'),(2,5,'wise','789',1,'${now}','${now}','${now}','${now}')`,
  `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Client','USD','${now}','${now}')`,
  `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Project','${now}','${now}')`,
  `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Task','${now}','${now}')`,
  `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'${now}','${now}'),(2,1,5,'${now}','${now}')`,
  `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${now}','${now}')`,
  `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at) VALUES
    (10,2,1,1,1,1,'2026-08-15',7200,7200,7200,1,5000,'${now}','${now}'),
    (11,2,1,1,1,1,'2026-09-02',1800,1800,1800,1,5000,'${now}','${now}'),
    (12,5,1,1,2,1,'2026-08-15',36000,36000,36000,1,9000,'${now}','${now}')`,
]

const event = (overrides: Partial<StaffPaymentCommand>): StaffPaymentCommand => ({
  id: 'event',
  user_id: 2,
  month: '2026-08',
  expected_version: 0,
  kind: 'amount',
  amount_cents: 10000,
  currency: 'USD',
  paid_on: null,
  due_on: null,
  reference: '',
  note: 'Agreed',
  payment_id: null,
  source: 'wise',
  ...overrides,
})
const payment = (id: string, user: number, version: number, cents: number, currency: string, ref: string) =>
  event({ id, user_id: user, expected_version: version, kind: 'payment', amount_cents: cents, currency, paid_on: '2026-09-10', reference: ref })

type Db = Parameters<typeof createMyPaymentsStore>[0]

/** Everything the two runtimes must agree on. `database` is already migrated and seeded. */
const scenario = async (database: Db): Promise<void> => {
  const ledger = createStaffPaymentStore(database)
  const mine = createMyPaymentsStore(database)
  // Person 2: 100.00 USD owed for August, 40.00 paid, a 10.00 receipt recorded then voided.
  await ledger.append(event({ id: 'a2' }), 1, 'r', now)
  await ledger.append(payment('p2a', 2, 1, 4000, 'USD', 'wise-2a'), 1, 'r', now)
  await ledger.append(payment('p2b', 2, 2, 1000, 'USD', 'wise-2b'), 1, 'r', now)
  await ledger.append(event({ id: 'v2b', expected_version: 3, kind: 'void', amount_cents: null, currency: null, payment_id: 'p2b', note: 'Wrong receipt' }), 1, 'r', now)
  // Person 5: another contractor with a different currency and amounts.
  await ledger.append(event({ id: 'a5', user_id: 5, amount_cents: 99900, currency: 'EUR' }), 1, 'r', now)
  await ledger.append(payment('p5a', 5, 1, 5000, 'EUR', 'wise-5a'), 1, 'r', now)
  // Person 3 holds an obligation without being flagged a contractor.
  await ledger.append(event({ id: 'a3', user_id: 3, amount_cents: 2500 }), 1, 'r', now)
  // ...and a historical settlement through June.
  await ledger.append(event({ id: 'o3', user_id: 3, month: '2026-06', kind: 'opening', amount_cents: null, currency: null, source: 'historical', note: 'Paid earlier' }), 1, 'r', now)
  // Scheduled Wise payments: 2 on the 20th local, 5 later.
  const runs = createPaymentRunsService(database, provider)
  for (const [run, user, amount, scheduled] of [
    ['Private run two', 2, 5000, '2026-10-20T03:00:00.000Z'],
    ['Private run five', 5, 5000, '2026-10-25T12:00:00.000Z'],
  ] as const) {
    const preview = await runs.preview(
      { id: crypto.randomUUID(), name: run, source_currency: 'USD', scheduled_at: scheduled, timezone: 'America/Costa_Rica', items: [{ user_id: user, month: '2026-08', amount_cents: amount, expected_version: user === 2 ? 4 : 2 }] },
      1,
      'req',
      now,
    )
    await runs.approve(preview.id, { limits: preview.items.map((item) => ({ item_id: item.id, max_source_cents: 5100 })) }, 1, 'req', now)
  }

  // The summary reconciles to the administrator ledger for the same person and month.
  const own = await mine.read(2, '2026-08', today)
  const register = (await ledger.report('2026-08', today)).rows.find((row) => row.user_id === 2)!
  expect(own).toEqual({
    month: '2026-08',
    hours_seconds: 7200,
    status: 'partial',
    owed: { amount_cents: 10000, currency: 'USD' },
    paid_cents: 4000,
    balance_cents: 6000,
    payments: [{ amount_cents: 4000, currency: 'USD', paid_on: '2026-09-10' }],
    upcoming: [{ amount_cents: 5000, currency: 'USD', scheduled_on: '2026-10-19', status: 'scheduled' }],
  })
  expect([own!.owed!.amount_cents, own!.paid_cents, own!.balance_cents, own!.status]).toEqual([
    register.amount_cents,
    register.paid_cents,
    register.balance_cents,
    register.status,
  ])

  // Strictly their own: nothing of person 5 or the run appears in person 2's answer.
  const text = JSON.stringify(own)
  for (const forbidden of ['EUR', '99900', 'wise-', 'Private', 'Five', '789', '456']) expect(text).not.toContain(forbidden)
  const other = await mine.read(5, '2026-08', today)
  expect(other).toMatchObject({ hours_seconds: 36000, owed: { amount_cents: 99900, currency: 'EUR' }, paid_cents: 5000, upcoming: [{ scheduled_on: '2026-10-25', currency: 'EUR' }] })
  expect(JSON.stringify(other)).not.toContain('"amount_cents":4000')

  // A month with no recorded obligation shows hours and "pending review", never an amount.
  expect(await mine.read(2, '2026-09', today)).toMatchObject({
    hours_seconds: 1800,
    status: 'pending_review',
    owed: null,
    paid_cents: 0,
    balance_cents: null,
    payments: [],
  })

  // An obligation holder who is not flagged is a payee; a historical settlement has no figure.
  expect(await mine.read(3, '2026-08', today)).toMatchObject({ status: 'pending', owed: { amount_cents: 2500, currency: 'USD' }, upcoming: [] })
  expect(await mine.read(3, '2026-05', today)).toMatchObject({ status: 'settled', owed: null, balance_cents: null })

  // Neither flagged nor holding an obligation, and a user that does not exist: not a payee.
  expect(await mine.read(4, '2026-08', today)).toBeNull()
  expect(await mine.read(404, '2026-08', today)).toBeNull()

}

let sqlite: BetterSqlite3.Database | undefined
afterEach(() => sqlite?.close())

describe('own payment summary (issue 100)', () => {
  it('[container/sqlite] reconciles to the ledger and never discloses another person', async () => {
    sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    for (const statement of seed) sqlite.exec(statement)
    await scenario(createContainerDatabase(sqlite))
  })

  it('[d1] reconciles to the ledger and never discloses another person', async () => {
    const { Miniflare } = await import('miniflare')
    const { migrateD1 } = await import('../src/migrate.js')
    const { createD1Database } = await import('../src/d1.js')
    const runtime = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await runtime.getD1Database('DB')
      await migrateD1(d1 as unknown as D1Database)
      for (const statement of seed) await d1.prepare(statement).run()
      await scenario(createD1Database(d1 as unknown as D1Database) as unknown as Db)
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})
