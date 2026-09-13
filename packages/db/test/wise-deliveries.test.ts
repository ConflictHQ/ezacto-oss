import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createWiseDeliveryStore, type WiseDeliveryStore } from '../src/wise-deliveries.js'

/**
 * Issue 543. Wise retries anything it did not get a 2xx for, and a retry after
 * a successful-but-slow handler is indistinguishable from a first delivery.
 *
 * Against a real migrated database rather than a fake, because the guarantees
 * being tested are the schema's: the primary key is what makes a claim
 * exclusive, and the payout log's own triggers are what stop a settled transfer
 * being rewritten.
 */

const t = (minute: number): string =>
  `2026-09-13T12:${String(minute).padStart(2, '0')}:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

const fixture = async (): Promise<{
  sqlite: BetterSqlite3.Database
  store: WiseDeliveryStore
}> => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (2, 'Contractor', 'Two', 'member', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO user_payout_accounts
      (id, user_id, provider, external_id, linked_by_user_id, linked_at, verified_at, created_at, updated_at)
      VALUES (1, 2, 'wise', '41000001', 2, '${t(0)}', '${t(0)}', '${t(0)}', '${t(0)}');
    INSERT INTO payout_transfers
      (id, user_id, period_start, period_end, payout_account_id, amount_cents,
       currency, state, external_transfer_id, created_at, updated_at)
      VALUES (1, 2, '2026-09-01', '2026-09-15', 1, 250000, 'USD', 'planned',
        '49983981', '${t(0)}', '${t(0)}');
  `)
  sqlite = database
  return { sqlite: database, store: createWiseDeliveryStore(createContainerDatabase(database)) }
}

const claim = (store: WiseDeliveryStore, overrides: Record<string, unknown> = {}) =>
  store.claim({
    deliveryId: 'delivery-1',
    subscriptionId: 'sub-1',
    eventType: 'transfers#state-change',
    transferId: '49983981',
    currentState: 'outgoing_payment_sent',
    occurredAt: '2026-09-13T10:00:00Z',
    now: t(1),
    ...overrides,
  } as never)

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('claiming a delivery (#543)', () => {
  it('[money] lets exactly one caller through for an id', async () => {
    const { store } = await fixture()
    expect(await claim(store)).toEqual({ claim: 'fresh' })
    // The retry. Anything but `duplicate` here settles a payout twice.
    expect(await claim(store)).toEqual({ claim: 'duplicate' })
  })

  it('[money] tells two genuinely different deliveries apart', async () => {
    const { store } = await fixture()
    await claim(store)
    expect(await claim(store, { deliveryId: 'delivery-2' })).toEqual({ claim: 'fresh' })
  })

  it('[db] records what arrived, unprocessed until it is finished', async () => {
    const { store } = await fixture()
    await claim(store)
    expect(await store.historyForTransfer('49983981')).toEqual([
      {
        deliveryId: 'delivery-1',
        eventType: 'transfers#state-change',
        transferId: '49983981',
        currentState: 'outgoing_payment_sent',
        occurredAt: '2026-09-13T10:00:00Z',
        receivedAt: t(1),
        // Null while known but not acted on, so a crash in between is visible
        // rather than silently dropped.
        processedAt: null,
        skippedReason: null,
      },
    ])
  })

  it('[db] keeps why a delivery was not acted on', async () => {
    const { store } = await fixture()
    await claim(store)
    await store.finish('delivery-1', t(2), 'state processing is not final')
    const [row] = await store.historyForTransfer('49983981')
    expect(row).toMatchObject({
      processedAt: t(2),
      skippedReason: 'state processing is not final',
    })
  })

  it('[db] refuses to rewrite what a delivery said', async () => {
    // The ledger is a record of what Wise sent, not a summary of what we now
    // believe. The whole reason to keep it is that those two differ.
    const { sqlite: database, store } = await fixture()
    await claim(store)
    expect(() =>
      database
        .prepare(`UPDATE wise_webhook_deliveries SET current_state = 'cancelled' WHERE delivery_id = ?`)
        .run('delivery-1'),
    ).toThrow(/is immutable/u)
  })
})

describe('settling the payout a transfer paid for (#543)', () => {
  const settle = (store: WiseDeliveryStore, overrides: Record<string, unknown> = {}) =>
    store.settleTransfer({
      transferId: '49983981',
      outcome: 'sent',
      failureReason: null,
      now: t(2),
      ...overrides,
    } as never)

  it('[money] moves a planned payout to sent', async () => {
    const { sqlite: database, store } = await fixture()
    expect(await settle(store)).toEqual({ settled: 'sent', transferId: '49983981' })
    expect(database.prepare(`SELECT state FROM payout_transfers WHERE id = 1`).get()).toEqual({
      state: 'sent',
    })
  })

  it('[money] records why a payout failed, in the row itself', async () => {
    const { sqlite: database, store } = await fixture()
    expect(
      await settle(store, { outcome: 'failed', failureReason: 'wise reported cancelled' }),
    ).toEqual({ settled: 'failed', transferId: '49983981' })
    expect(
      database.prepare(`SELECT state, failure_reason FROM payout_transfers WHERE id = 1`).get(),
    ).toEqual({ state: 'failed', failure_reason: 'wise reported cancelled' })
  })

  it('[money] refuses to settle an already-settled payout twice', async () => {
    const { store } = await fixture()
    await settle(store)
    // The schema would refuse this write anyway -- a sent row is immutable --
    // so saying so beats a constraint error that reads like a bug.
    expect(await settle(store)).toEqual({
      settled: 'none',
      reason: 'payout transfer already sent',
    })
  })

  it('[money] says so where no payout claimed that transfer', async () => {
    // Somebody may have moved money at Wise directly, which is their business
    // and not a payout to invent.
    const { store } = await fixture()
    expect(await settle(store, { transferId: '99999999' })).toEqual({
      settled: 'none',
      reason: 'no matching payout transfer',
    })
  })

  it('[money] releases the period when a transfer fails, and not before', async () => {
    const { sqlite: database, store } = await fixture()
    // The live claim on the period is what stops a second payout for the same
    // fortnight; only a failure lets another attempt through.
    const second = () =>
      database
        .prepare(
          `INSERT INTO payout_transfers
             (user_id, period_start, period_end, payout_account_id, amount_cents,
              currency, state, created_at, updated_at)
           VALUES (2, '2026-09-01', '2026-09-15', 1, 250000, 'USD', 'planned', ?, ?)`,
        )
        .run(t(3), t(3))
    expect(second).toThrow(/UNIQUE/u)
    await settle(store, { outcome: 'failed', failureReason: 'wise reported cancelled' })
    expect(second).not.toThrow()
  })
})
