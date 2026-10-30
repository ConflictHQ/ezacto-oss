import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql, type SQL } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createWiseRuntime } from '@ezacto/integrations'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  migrateContainer,
  migrateD1,
  migrateContainerThrough,
  migrateD1Through,
} from '../src/migrate.js'
import { createWiseDeliveryStore } from '../src/wise-deliveries.js'

const now = '2026-09-13T12:00:00.000Z'
const body = (id: number, second = 1) =>
  JSON.stringify({
    data: {
      resource: { id, profile_id: 16055450, type: 'transfer' },
      current_state: 'outgoing_payment_sent',
      previous_state: 'processing',
      occurred_at: now,
    },
    subscription_id: 'synthetic-subscription',
    event_type: 'transfers#state-change',
    schema_version: '2.0.0',
    sent_at: `2026-09-13T11:00:0${second}Z`,
  })
const identity = (payload: string) =>
  `wise-body-sha256:${createHash('sha256').update(payload).digest('hex')}`

for (const runtime of ['sqlite', 'd1'] as const) {
  it(`[security] signed Wise retries preserve one financial settlement and historical history (${runtime})`, async () => {
    const sqlite = runtime === 'sqlite' ? new BetterSqlite3(':memory:') : null
    const mf =
      runtime === 'd1'
        ? new Miniflare({
            modules: true,
            script: 'export default { fetch() { return new Response("ok") } }',
            d1Databases: ['DB'],
          })
        : null
    const binding = await mf?.getD1Database('DB')
    const database = sqlite ? createContainerDatabase(sqlite) : createD1Database(binding!)
    try {
      if (sqlite) migrateContainerThrough(sqlite, '0155_organization_holidays')
      else await migrateD1Through(binding!, '0155_organization_holidays')
      for (const statement of [
        `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Synthetic','{}','${now}','${now}')`,
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Admin','Synthetic','administrator','[]','${now}','${now}'),(2,'Worker','Synthetic','member','[]','${now}','${now}')`,
        `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','41000001',2,'${now}','${now}','${now}','${now}')`,
        `INSERT INTO payout_transfers(id,user_id,period_start,period_end,payout_account_id,amount_cents,currency,state,external_transfer_id,created_at,updated_at) VALUES(1,2,'2026-09-01','2026-09-15',1,250000,'USD','planned','49983981','${now}','${now}'),(2,2,'2026-08-01','2026-08-15',1,120000,'USD','planned','49983982','${now}','${now}')`,
      ])
        await database.run(sql.raw(statement))
      const store = createWiseDeliveryStore(database)
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const signature = (payload: string) =>
        Buffer.from(sign('RSA-SHA256', Buffer.from(payload), pair.privateKey)).toString('base64')
      const wise = createWiseRuntime({
        config: {
          token: 'synthetic-unused',
          profileId: undefined,
          webhookPublicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        accounts: {
          listForUser: async () => [],
          listForProvider: async () => [],
          awaitingDestination: async () => [],
          link: async () => ({ outcome: 'unknown_user' as const }),
          markVerified: async () => undefined,
          detach: async () => false,
        },
        deliveries: store,
        now: () => new Date(now),
      })
      const deliver = (payload: string, deliveryId: string | null, signed = signature(payload)) =>
        wise.webhook!.receiveWebhook({ payload, signature: signed, deliveryId, isTest: false })
      const payload = body(49983981)
      await expect(
        store.claim({
          deliveryId: identity(payload),
          subscriptionId: 'synthetic',
          eventType: 'transfers#state-change',
          transferId: '49983981',
          currentState: 'outgoing_payment_sent',
          occurredAt: now,
          now,
        }),
      ).rejects.toThrow()
      // Real pre-upgrade rows, including one with the exact future trusted key.
      await database.run(sql`INSERT INTO wise_webhook_deliveries
        (delivery_id,subscription_id,event_type,transfer_id,current_state,occurred_at,received_at,processed_at,skipped_reason)
        VALUES(${identity(payload)},'legacy-other-event','transfers#state-change','49983981','processing',${now},${now},${now},'legacy in-flight event'),
          ('legacy-header','synthetic-subscription','transfers#state-change','49983982','outgoing_payment_sent',${now},${now},${now},NULL)`)
      await store.settleTransfer({
        transferId: '49983982',
        outcome: 'sent',
        failureReason: null,
        now,
      })
      const historical = await database.all(sql`SELECT * FROM payout_transfers WHERE id=2`)
      const legacyRows = await database.all(
        sql`SELECT * FROM wise_webhook_deliveries ORDER BY delivery_id`,
      )
      if (sqlite) migrateContainer(sqlite)
      else await migrateD1(binding!)
      expect(
        await database.all(sql`SELECT * FROM wise_webhook_deliveries ORDER BY delivery_id`),
      ).toEqual(legacyRows)
      expect(await deliver(payload, 'untrusted-original')).toEqual({ accepted: true })
      const settled = await database.all(sql`SELECT * FROM payout_transfers WHERE id=1`)
      expect(settled[0]).toMatchObject({ state: 'sent', amount_cents: 250000, currency: 'USD' })
      await Promise.all(
        ['changed-header', null, 'untrusted-original'].map((header) => deliver(payload, header)),
      )
      const history = await store.historyForTransfer('49983981')
      expect(
        history.map(({ deliveryId, identitySource }) => ({ deliveryId, identitySource })),
      ).toEqual([
        { deliveryId: identity(payload), identitySource: 'signed-payload' },
        { deliveryId: identity(payload), identitySource: 'legacy-header' },
      ])
      expect(await store.historyForTransfer('49983981')).toEqual(history)
      const write = async (statement: SQL): Promise<void> => {
        await database.run(statement)
      }
      await expect(
        write(
          sql`UPDATE wise_signed_webhook_deliveries SET delivery_id='rewritten' WHERE delivery_id=${identity(payload)}`,
        ),
      ).rejects.toThrow()
      await expect(
        write(
          sql`UPDATE wise_signed_webhook_deliveries SET current_state='cancelled' WHERE delivery_id=${identity(payload)}`,
        ),
      ).rejects.toThrow()
      await expect(
        write(sql`DELETE FROM wise_all_webhook_deliveries WHERE delivery_id=${identity(payload)}`),
      ).rejects.toThrow()

      expect(await database.all(sql`SELECT * FROM payout_transfers WHERE id=1`)).toEqual(settled)
      expect(
        await database.all(sql`SELECT * FROM wise_webhook_deliveries ORDER BY delivery_id`),
      ).toEqual(legacyRows)

      // Same unsigned header, different authenticated bytes: keep both events,
      // while the existing planned-only fence keeps the settled money immutable.
      const other = body(49983981, 2)
      expect(await deliver(other, 'untrusted-original')).toEqual({ accepted: true })
      expect(
        new Set((await store.historyForTransfer('49983981')).map((event) => event.deliveryId)),
      ).toEqual(new Set([identity(payload), identity(other)]))
      expect(await database.all(sql`SELECT * FROM payout_transfers WHERE id=1`)).toEqual(settled)
      expect(await deliver(body(49983982), 'forged-header', signature(payload))).toEqual({
        accepted: false,
      })
      expect(await store.historyForTransfer('49983982')).toHaveLength(1)
      expect(await database.all(sql`SELECT * FROM payout_transfers WHERE id=2`)).toEqual(historical)

      // Existing header-keyed rows remain readable. First delivery after the
      // upgrade adds a body-keyed event but cannot resettle historical money.
      await deliver(body(49983982), 'legacy-header')
      await deliver(body(49983982), 'different-header')
      expect(
        new Set((await store.historyForTransfer('49983982')).map((event) => event.deliveryId)),
      ).toEqual(new Set(['legacy-header', identity(body(49983982))]))
      expect(await database.all(sql`SELECT * FROM payout_transfers WHERE id=2`)).toEqual(historical)
      expect(
        await database.all(sql`SELECT * FROM wise_webhook_deliveries ORDER BY delivery_id`),
      ).toEqual(legacyRows)
    } finally {
      sqlite?.close()
      await mf?.dispose()
    }
  }, 60000)
}
