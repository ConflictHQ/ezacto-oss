import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PaymentProvider, type PaymentQuote } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import { createPaymentRunsService } from '../src/payment-runs.js'
const closers: Array<() => unknown> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})
const stamp = '2026-09-30T12:00:00.000Z'
const fixture = async (kind: 'sqlite' | 'd1') => {
  const raw = kind === 'sqlite' ? new BetterSqlite3(':memory:') : null
  const mf = raw
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: ['DB'],
      })
  const binding = await mf?.getD1Database('DB')
  if (raw) migrateContainer(raw)
  else await migrateD1(binding!)
  closers.push(() => raw?.close() ?? mf?.dispose())
  const db = raw ? createContainerDatabase(raw) : createD1Database(binding!)
  for (const query of [
    `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned','{}','${stamp}','${stamp}')`,
    `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','Admin','administrator','[]','${stamp}','${stamp}'),(2,'Owned','Person','member','[]','${stamp}','${stamp}')`,
    `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','456',1,'${stamp}','${stamp}','${stamp}','${stamp}')`,
  ])
    await db.run(sql.raw(query))
  const ledger = createStaffPaymentStore(db)
  await ledger.append(
    {
      id: 'owned-obligation',
      user_id: 2,
      month: '2026-08',
      expected_version: 0,
      kind: 'amount',
      amount_cents: 10000,
      currency: 'USD',
      paid_on: null,
      due_on: null,
      reference: '',
      note: 'Owned',
      payment_id: null,
      source: 'wise',
    },
    1,
    'owned',
    stamp,
  )
  const quote: PaymentQuote = {
    id: 'owned-quote',
    profile_id: '123',
    recipient_id: '456',
    recipient_name: 'Owned Person',
    source_currency: 'USD',
    target_currency: 'USD',
    source_cents: 5050,
    target_cents: 5000,
    fee_cents: 50,
    rate: 1,
    expires_at: '2026-09-30T13:00:00.000Z',
    estimated_arrival: null,
  }
  let status = 'incoming_payment_waiting',
    transaction = ''
  const transfer = () => ({
    id: '999',
    status,
    customer_transaction_id: transaction,
    recipient_id: '456',
    target_cents: 5000,
    target_currency: 'USD',
  })
  const provider: PaymentProvider = {
    quote: vi.fn(async () => quote),
    create: vi.fn(async (item) => {
      transaction = item.id
      return transfer()
    }),
    fund: vi.fn(async () => {
      status = 'processing'
      return 'accepted' as const
    }),
    read: vi.fn(async () => transfer()),
  }
  const service = createPaymentRunsService(db, provider)
  const preview = await service.preview(
    {
      id: crypto.randomUUID(),
      name: 'Owned',
      source_currency: 'USD',
      scheduled_at: stamp,
      timezone: 'UTC',
      items: [{ user_id: 2, month: '2026-08', amount_cents: 5000, expected_version: 1 }],
    },
    1,
    'owned',
    stamp,
  )
  await service.approve(
    preview.id,
    { limits: preview.items.map((item) => ({ item_id: item.id, max_source_cents: 5100 })) },
    1,
    'owned',
    stamp,
  )
  await service.processDue(stamp)
  return {
    service,
    provider,
    setStatus: (next: string) => {
      status = next
    },
    item: async () => (await service.report('2026-08', '2026-08', stamp)).runs[0]!.items[0]!,
    events: () =>
      db.all<{ kind: string }>(
        sql`SELECT kind FROM staff_payment_events WHERE kind IN ('payment','void')`,
      ),
    balance: async () =>
      (await ledger.report('2026-08', '2027-02-01')).rows.find((row) => row.user_id === 2)!,
  }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(`Wise return visibility ${kind}`, () => {
    it.each(['bounced_back', 'charged_back'])(
      'holds pre-send %s for review without funding again',
      async (status) => {
        const f = await fixture(kind)
        f.setStatus(status)
        await f.service.processDue('2026-09-30T12:02:00.000Z')
        expect(await f.item()).toMatchObject({
          state: 'attention',
          provider_status: status,
          failure: expect.stringContaining('Review'),
        })
        expect(await f.balance()).toMatchObject({ paid_cents: 0, reserved_cents: 5000 })
        expect(await f.events()).toEqual([])
        await f.service.processDue('2026-09-30T13:00:00.000Z')
        expect(f.provider.create).toHaveBeenCalledTimes(1)
        expect(f.provider.fund).toHaveBeenCalledTimes(1)
        f.setStatus('funds_refunded')
        await f.service.processDue('2026-09-30T14:00:00.000Z')
        expect(await f.item()).toMatchObject({ state: 'failed', provider_status: 'funds_refunded' })
        expect(await f.balance()).toMatchObject({
          paid_cents: 0,
          reserved_cents: 0,
          available_cents: 10000,
        })
        expect(await f.events()).toEqual([])
      },
    )
    it.each([
      ['bounced_back', 'outgoing_payment_sent'],
      ['charged_back', 'outgoing_payment_sent'],
      ['bounced_back', 'funds_refunded'],
      ['charged_back', 'funds_refunded'],
    ])('keeps sent %s pending review until %s', async (status, resolution) => {
      const f = await fixture(kind)
      f.setStatus('outgoing_payment_sent')
      await f.service.processDue('2026-09-30T12:02:00.000Z')
      f.setStatus(status!)
      await f.service.processDue('2026-10-01T12:00:00.000Z')
      expect(await f.item()).toMatchObject({
        state: 'paid',
        provider_status: status,
        failure: expect.stringContaining('Review'),
      })
      expect(await f.balance()).toMatchObject({ paid_cents: 5000, reserved_cents: 0 })
      expect(await f.events()).toEqual([{ kind: 'payment' }])
      expect(await f.service.processDue('2027-01-15T12:00:00.000Z')).toMatchObject({ examined: 1 })
      f.setStatus('processing')
      await f.service.processDue('2027-01-15T12:10:00.000Z')
      expect(await f.item()).toMatchObject({
        state: 'paid',
        failure: expect.stringContaining('earlier issue'),
      })
      f.setStatus(resolution!)
      await f.service.processDue('2027-01-15T12:20:00.000Z')
      expect(await f.item()).toMatchObject({
        state: resolution === 'funds_refunded' ? 'failed' : 'paid',
        provider_status: resolution,
      })
      expect(await f.events()).toEqual(
        resolution === 'funds_refunded'
          ? [{ kind: 'payment' }, { kind: 'void' }]
          : [{ kind: 'payment' }],
      )
      if (resolution === 'outgoing_payment_sent') expect((await f.item()).failure).toBeNull()
      expect(f.provider.create).toHaveBeenCalledTimes(1)
      expect(f.provider.fund).toHaveBeenCalledTimes(1)
    })
  })
