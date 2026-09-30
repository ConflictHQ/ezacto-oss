import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import { createPaymentRunsService } from '../src/payment-runs.js'
import {
  PaymentProviderError,
  type PaymentProvider,
  type PaymentRunCommand,
  type PaymentQuote,
} from '@ezacto/core'
let db: BetterSqlite3.Database
const now = '2026-09-30T12:00:00.000Z'
const quote: PaymentQuote = {
  id: 'quote-1',
  profile_id: '123',
  recipient_id: '456',
  recipient_name: 'Person Two',
  source_currency: 'USD',
  target_currency: 'USD',
  source_cents: 5050,
  target_cents: 5000,
  fee_cents: 50,
  rate: 1,
  expires_at: '2026-09-30T13:00:00.000Z',
  estimated_arrival: null,
}
const fixture = async () => {
  db = new BetterSqlite3(':memory:')
  migrateContainer(db)
  db.exec(`INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Fixture','{}','${now}','${now}');
 INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Admin','One','administrator','[]','${now}','${now}'),(2,'Person','Two','member','[]','${now}','${now}');
 INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','456',1,'${now}','${now}','${now}','${now}');`)
  const database = createContainerDatabase(db)
  const ledger = createStaffPaymentStore(database)
  const obligation = {
    id: 'amount',
    user_id: 2,
    month: '2026-08',
    expected_version: 0,
    kind: 'amount' as const,
    amount_cents: 10000,
    currency: 'USD',
    paid_on: null,
    due_on: null,
    reference: '',
    note: 'Agreed',
    payment_id: null,
    source: 'wise' as const,
  }
  await ledger.append(obligation, 1, 'request', now)
  let status = 'incoming_payment_waiting'
  let transaction = ''
  const provider: PaymentProvider = {
    quote: vi.fn(async () => ({ ...quote })),
    create: vi.fn(async (item) => {
      transaction = item.id
      return {
        id: '999',
        status,
        customer_transaction_id: transaction,
        recipient_id: '456',
        target_cents: 5000,
        target_currency: 'USD',
      }
    }),
    fund: vi.fn(async () => {
      status = 'processing'
      return 'accepted' as const
    }),
    read: vi.fn(async () => ({
      id: '999',
      status,
      customer_transaction_id: transaction,
      recipient_id: '456',
      target_cents: 5000,
      target_currency: 'USD',
    })),
  }
  const service = createPaymentRunsService(database, provider)
  const command: PaymentRunCommand = {
    id: crypto.randomUUID(),
    name: 'August payroll',
    source_currency: 'USD',
    scheduled_at: now,
    timezone: 'America/Costa_Rica',
    items: [{ user_id: 2, month: '2026-08', amount_cents: 5000, expected_version: 1 }],
  }
  const preview = () => service.preview(command, 1, 'request', now)
  const approve = async () => {
    const run = await preview()
    return service.approve(
      run.id,
      { limits: run.items.map((i) => ({ item_id: i.id, max_source_cents: 5100 })) },
      1,
      'approval',
      now,
    )
  }
  return {
    service,
    provider,
    ledger,
    command,
    preview,
    approve,
    obligation,
    setStatus: (value: string) => {
      status = value
    },
  }
}
afterEach(() => db?.close())
describe('scheduled payment runs', () => {
  it('previews without sending or reserving; approval reserves only approved amounts', async () => {
    const f = await fixture()
    await f.preview()
    expect(f.provider.create).not.toHaveBeenCalled()
    expect((await f.ledger.report('2026-08', '2026-09-30')).rows[1]?.reserved_cents).toBe(0)
    await f.approve()
    expect(
      (await f.ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2),
    ).toMatchObject({ reserved_cents: 5000, available_cents: 5000, paid_cents: 0 })
  })
  it('rejects concurrent over-reservation atomically and prevents manual overspending', async () => {
    const f = await fixture()
    f.command.items[0]!.amount_cents = 8000
    const first = await f.preview()
    const second = await f.service.preview(
      { ...f.command, id: crypto.randomUUID() },
      1,
      'second',
      now,
    )
    const attempts = await Promise.allSettled(
      [first, second].map((r) =>
        f.service.approve(
          r.id,
          { limits: r.items.map((i) => ({ item_id: i.id, max_source_cents: 9000 })) },
          1,
          'approve',
          now,
        ),
      ),
    )
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    await expect(
      f.ledger.append(
        {
          ...f.obligation,
          id: 'manual',
          expected_version: 1,
          kind: 'payment',
          amount_cents: 5000,
          paid_on: '2026-09-30',
          reference: 'external',
        },
        1,
        'manual',
        now,
      ),
    ).rejects.toThrow(/reserved/)
    await expect(
      f.ledger.append(
        { ...f.obligation, id: 'reduce', expected_version: 1, amount_cents: 7000 },
        1,
        'manual',
        now,
      ),
    ).rejects.toThrow(/reserved/)
  })
  it('processes one durable stage at a time, records once and reverses confirmed refunds', async () => {
    const f = await fixture()
    await f.approve()
    await f.service.processDue(now)
    await f.service.processDue(now)
    await f.service.processDue(now)
    expect(f.provider.create).toHaveBeenCalledTimes(1)
    expect(f.provider.fund).toHaveBeenCalledTimes(1)
    f.setStatus('outgoing_payment_sent')
    await f.service.processDue('2026-09-30T12:02:00.000Z')
    await f.service.processDue('2026-09-30T12:03:00.000Z')
    expect(
      (await f.ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2),
    ).toMatchObject({ paid_cents: 5000, reserved_cents: 0, balance_cents: 5000 })
    f.setStatus('funds_refunded')
    await f.service.processDue('2026-09-30T14:00:00.000Z')
    expect(
      (await f.ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2),
    ).toMatchObject({ paid_cents: 0, balance_cents: 10000 })
  })
  it('settles successful items while a failed sibling retains its own reservation', async () => {
    const f = await fixture()
    await f.ledger.append({ ...f.obligation, id: 'september', month: '2026-09' }, 1, 'request', now)
    f.command.items.push({ ...f.command.items[0]!, month: '2026-09' })
    const create = f.provider.create
    f.provider.create = vi.fn(async (item, executionQuote) => {
      if (item.month === '2026-09') throw new PaymentProviderError('temporarily unavailable', 503)
      return create(item, executionQuote)
    })
    await f.approve()
    await f.service.processDue(now)
    f.setStatus('outgoing_payment_sent')
    await f.service.processDue('2026-09-30T12:02:00.000Z')
    const report = await f.service.report('2026-08', '2026-09', now)
    expect(report.runs[0]?.items.find((item) => item.month === '2026-08')?.state).toBe('paid')
    expect(report.runs[0]?.items.find((item) => item.month === '2026-09')?.state).toBe('creating')
    expect(report.ledgers[0]?.rows.find((row) => row.user_id === 2)).toMatchObject({
      paid_cents: 5000,
      reserved_cents: 0,
    })
    expect(report.ledgers[1]?.rows.find((row) => row.user_id === 2)).toMatchObject({
      paid_cents: 0,
      reserved_cents: 5000,
    })
    expect(f.provider.fund).toHaveBeenCalledTimes(1)
  })
  it('rolls back every reservation if one item changed after the review', async () => {
    const f = await fixture()
    await f.ledger.append({ ...f.obligation, id: 'september', month: '2026-09' }, 1, 'request', now)
    f.command.items.push({ ...f.command.items[0]!, month: '2026-09' })
    await f.preview()
    await f.ledger.append(
      { ...f.obligation, id: 'changed', month: '2026-09', expected_version: 1, amount_cents: 4000 },
      1,
      'change',
      now,
    )
    await expect(f.approve()).rejects.toThrow(/balance or destination changed/)
    const report = await f.service.report('2026-08', '2026-09', now)
    expect(report.runs[0]?.state).toBe('draft')
    expect(report.runs[0]?.items.every((item) => item.state === 'draft')).toBe(true)
    expect(
      report.ledgers.every((ledger) => ledger.rows.every((row) => row.reserved_cents === 0)),
    ).toBe(true)
  })
  it('never repeats funding after a lost response, and holds the reservation', async () => {
    const f = await fixture()
    vi.mocked(f.provider.fund).mockRejectedValue(new Error('connection lost'))
    await f.approve()
    await f.service.processDue(now)
    await f.service.processDue(now)
    await f.service.processDue(now)
    await f.service.processDue('2026-09-30T12:03:00.000Z')
    expect(f.provider.fund).toHaveBeenCalledTimes(1)
    const report = await f.service.report('2026-08', '2026-08', now)
    expect(report.runs[0]?.items[0]?.state).toBe('attention')
    expect(report.ledgers[0]?.rows.find((x) => x.user_id === 2)?.reserved_cents).toBe(5000)
  })
  it('reuses the persisted transaction and quote after an ambiguous create', async () => {
    const f = await fixture()
    vi.mocked(f.provider.create).mockRejectedValueOnce(new Error('response lost'))
    await f.approve()
    await f.service.processDue(now)
    await f.service.processDue(now)
    await f.service.processDue('2026-09-30T13:01:00.000Z')
    const calls = vi.mocked(f.provider.create).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[0].id).toBe(calls[1]?.[0].id)
    expect(calls[0]?.[1]).toEqual(calls[1]?.[1])
  })
  it('does not send early and cancels unstarted reservations', async () => {
    const f = await fixture()
    f.command.scheduled_at = '2026-10-01T12:00:00.000Z'
    const run = await f.approve()
    expect(await f.service.processDue(now)).toEqual({ examined: 0 })
    await f.service.cancel(run.id, 1, 'cancel', now)
    expect(
      (await f.ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2)
        ?.reserved_cents,
    ).toBe(0)
    expect(f.provider.create).not.toHaveBeenCalled()
  })
  it('pauses cost increases and changed destinations without creating transfers', async () => {
    const f = await fixture()
    const run = await f.approve()
    vi.mocked(f.provider.quote).mockResolvedValue({ ...quote, source_cents: 6000 })
    await f.service.processDue(now)
    expect((await f.service.report('2026-08', '2026-08', now)).runs[0]?.items[0]?.state).toBe(
      'attention',
    )
    expect(f.provider.create).not.toHaveBeenCalled()
    await f.service.cancel(run.id, 1, 'cancel', now)
    expect(
      (await f.ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2)
        ?.reserved_cents,
    ).toBe(0)
  })
  it('honors provider backoff without creating a new payment', async () => {
    const f = await fixture()
    await f.approve()
    vi.mocked(f.provider.quote).mockRejectedValue(
      new PaymentProviderError('rate limited', 429, 300),
    )
    await f.service.processDue(now)
    await f.service.processDue('2026-09-30T12:01:00.000Z')
    expect(f.provider.quote).toHaveBeenCalledTimes(2)
  })
  it('waits for Retry-After before retrying an explicitly rate-limited funding request', async () => {
    const f = await fixture()
    const original = f.provider.fund
    f.provider.fund = vi
      .fn()
      .mockRejectedValueOnce(new PaymentProviderError('limited', 429, 300))
      .mockImplementation(original)
    await f.approve()
    await f.service.processDue(now)
    await f.service.processDue('2026-09-30T12:01:00.000Z')
    expect(f.provider.fund).toHaveBeenCalledTimes(1)
    await f.service.processDue('2026-09-30T12:06:00.000Z')
    expect(f.provider.fund).toHaveBeenCalledTimes(2)
    expect(f.provider.create).toHaveBeenCalledTimes(1)
  })
  it('holds changed destinations for a fresh review and releases them only on cancellation', async () => {
    const f = await fixture()
    const run = await f.approve()
    db.prepare('UPDATE user_payout_accounts SET detached_at=? WHERE id=1').run(now)
    await f.service.processDue(now)
    expect(f.provider.create).not.toHaveBeenCalled()
    expect((await f.service.report('2026-08', '2026-08', now)).runs[0]?.items[0]?.state).toBe(
      'attention',
    )
    await f.service.cancel(run.id, 1, 'cancel', now)
    expect(
      (await f.ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2)
        ?.reserved_cents,
    ).toBe(0)
  })
  it('is idempotent for repeated preview and approval and refuses changed approvals', async () => {
    const f = await fixture()
    const a = await f.preview()
    expect((await f.preview()).id).toBe(a.id)
    const approved = await f.approve()
    expect((await f.approve()).items).toEqual(approved.items)
    await expect(
      f.service.approve(
        a.id,
        { limits: [{ item_id: a.items[0]!.id, max_source_cents: 6000 }] },
        1,
        'other',
        now,
      ),
    ).rejects.toThrow(/different limits/)
  })
})

it('[d1] atomically approves runs and shares reservations with manual payments', async () => {
  const { Miniflare } = await import('miniflare')
  const { migrateD1 } = await import('../src/migrate.js')
  const { createD1Database } = await import('../src/d1.js')
  const f = await fixture()
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  try {
    const d1 = await runtime.getD1Database('DB')
    await migrateD1(d1 as unknown as D1Database)
    for (const table of [
      'organizations',
      'users',
      'user_payout_accounts',
      'staff_payment_events',
    ]) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
      for (const row of rows) {
        if (table === 'users') delete row.is_owner
        await d1
          .prepare(
            `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
              .map(() => '?')
              .join(',')})`,
          )
          .bind(...Object.values(row))
          .run()
      }
    }
    const database = createD1Database(d1 as unknown as D1Database)
    const service = createPaymentRunsService(database, f.provider)
    const runs = []
    for (let i = 0; i < 3; i++)
      runs.push(await service.preview({ ...f.command, id: crypto.randomUUID() }, 1, 'preview', now))
    const results = await Promise.allSettled(
      runs.map((run) =>
        service.approve(
          run.id,
          { limits: run.items.map((item) => ({ item_id: item.id, max_source_cents: 5100 })) },
          1,
          'approve',
          now,
        ),
      ),
    )
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2)
    const ledger = createStaffPaymentStore(database)
    expect(
      (await ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2),
    ).toMatchObject({ reserved_cents: 10000, available_cents: 0, paid_cents: 0 })
    await expect(
      ledger.append(
        {
          ...f.obligation,
          id: 'manual',
          expected_version: 1,
          kind: 'payment',
          amount_cents: 1,
          paid_on: '2026-09-30',
          reference: 'other',
        },
        1,
        'manual',
        now,
      ),
    ).rejects.toThrow(/reserved/)
    for (const run of runs) await service.cancel(run.id, 1, 'cancel', now)
    const fresh = await service.preview({ ...f.command, id: crypto.randomUUID() }, 1, 'new', now)
    await service.approve(
      fresh.id,
      { limits: fresh.items.map((item) => ({ item_id: item.id, max_source_cents: 5100 })) },
      1,
      'approve',
      now,
    )
    await service.processDue(now)
    f.setStatus('outgoing_payment_sent')
    await service.processDue('2026-09-30T12:02:00.000Z')
    expect(
      (await ledger.report('2026-08', '2026-09-30')).rows.find((x) => x.user_id === 2),
    ).toMatchObject({ paid_cents: 5000, reserved_cents: 0, balance_cents: 5000 })
  } finally {
    await runtime.dispose()
  }
}, 60000)
