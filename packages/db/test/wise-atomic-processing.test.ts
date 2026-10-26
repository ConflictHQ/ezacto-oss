import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import { createWiseRuntime } from '@ezacto/integrations'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createWiseDeliveryStore } from '../src/wise-deliveries.js'

const received = '2026-10-23T00:00:00.000Z'
const now = '2026-10-24T00:00:00.000Z'
const event = (id: number, state = 'outgoing_payment_sent') =>
  JSON.stringify({
    data: {
      resource: { id, profile_id: 16055450, type: 'transfer' },
      current_state: state,
      previous_state: 'processing',
      occurred_at: received,
    },
    subscription_id: 'fixture',
    event_type: 'transfers#state-change',
    schema_version: '2.0.0',
    sent_at: received,
  })
const key = (payload: string) =>
  `wise-body-sha256:${createHash('sha256').update(payload).digest('hex')}`

for (const runtime of ['sqlite', 'd1'] as const) {
  it(`[money #1202] atomic failure recovery and concurrent trusted replay (${runtime})`, async () => {
    const sqlite = runtime === 'sqlite' ? new BetterSqlite3(':memory:') : null
    const mf =
      runtime === 'd1'
        ? new Miniflare({
            modules: true,
            script: 'export default {fetch(){return new Response("ok")}}',
            d1Databases: ['DB'],
          })
        : null
    const binding = await mf?.getD1Database('DB')
    const db = sqlite ? createContainerDatabase(sqlite) : createD1Database(binding!)
    const run = async (query: string) => {
      await db.run(sql.raw(query))
    }
    const rows = async (query: string) => db.all(sql.raw(query))
    try {
      if (sqlite) migrateContainer(sqlite)
      else await migrateD1(binding!)
      for (const query of [
        `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Synthetic','{}','${received}','${received}')`,
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Admin','Fixture','administrator','[]','${received}','${received}'),(2,'Worker','Fixture','member','[]','${received}','${received}')`,
        `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','41000001',2,'${received}','${received}','${received}','${received}')`,
        ...[1, 2, 3].map(
          (id) =>
            `INSERT INTO payout_transfers(id,user_id,period_start,period_end,payout_account_id,amount_cents,currency,state,external_transfer_id,created_at,updated_at) VALUES(${id},2,'2026-0${id}-01','2026-0${id}-15',1,250000,'USD','planned','${49983980 + id}','${received}','${received}')`,
        ),
        `CREATE TABLE wise_fault(stage TEXT)`,
        `CREATE TABLE wise_transition_audit(payout_id INTEGER,old_state TEXT,new_state TEXT)`,
        `CREATE TRIGGER wise_test_audit AFTER UPDATE OF state ON payout_transfers WHEN OLD.state<>NEW.state BEGIN INSERT INTO wise_transition_audit VALUES(NEW.id,OLD.state,NEW.state); END`,
        `CREATE TRIGGER wise_fail_before BEFORE UPDATE OF state ON payout_transfers WHEN EXISTS(SELECT 1 FROM wise_fault WHERE stage='before') BEGIN SELECT RAISE(ABORT,'injected before settlement'); END`,
        `CREATE TRIGGER wise_fail_after BEFORE UPDATE OF processed_at ON wise_signed_webhook_deliveries WHEN EXISTS(SELECT 1 FROM wise_fault WHERE stage='after') BEGIN SELECT RAISE(ABORT,'injected after settlement'); END`,
      ])
        await run(query)
      const store = createWiseDeliveryStore(db)
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
      let clock = now
      const providerFetch = vi.fn(async () => {
        throw new Error('Provider calls forbidden in this test')
      })
      const wise = createWiseRuntime({
        fetch: providerFetch,
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
        now: () => new Date(clock),
      })
      const deliver = (
        payload: string,
        signature = Buffer.from(sign('RSA-SHA256', Buffer.from(payload), pair.privateKey)).toString(
          'base64',
        ),
      ) =>
        wise.webhook!.receiveWebhook({
          payload,
          signature,
          deliveryId: 'untrusted-header',
          isTest: false,
        })
      const first = event(49983981)
      for (const stage of ['before', 'after']) {
        await run(`INSERT INTO wise_fault VALUES('${stage}')`)
        await expect(deliver(first)).rejects.toThrow()
        expect(await store.historyForTransfer('49983981')).toEqual([])
        expect(await rows('SELECT state FROM payout_transfers WHERE id=1')).toEqual([
          { state: 'planned' },
        ])
        expect(await rows('SELECT * FROM wise_transition_audit')).toEqual([])
        await run('DELETE FROM wise_fault')
      }
      await Promise.all([deliver(first), deliver(first), deliver(first)])
      expect(await rows('SELECT * FROM wise_transition_audit')).toEqual([
        { payout_id: 1, old_state: 'planned', new_state: 'sent' },
      ])
      const completed = await store.historyForTransfer('49983981')
      const money = await rows('SELECT * FROM payout_transfers WHERE id=1')
      clock = '2026-10-24T01:00:00.000Z'
      await deliver(first)
      expect(await store.historyForTransfer('49983981')).toEqual(completed)
      expect(await rows('SELECT * FROM payout_transfers WHERE id=1')).toEqual(money)
      expect(await rows('SELECT * FROM wise_transition_audit')).toHaveLength(1)

      // A pre-existing trusted pending claim resumes, retaining its first receipt.
      const pending = event(49983982)
      await store.claim({
        deliveryId: key(pending),
        subscriptionId: 'fixture',
        eventType: 'transfers#state-change',
        transferId: '49983982',
        currentState: 'outgoing_payment_sent',
        occurredAt: received,
        now: received,
      })
      const pendingBefore = await store.historyForTransfer('49983982')
      await run("INSERT INTO wise_fault VALUES('after')")
      await expect(deliver(pending)).rejects.toThrow()
      expect(await store.historyForTransfer('49983982')).toEqual(pendingBefore)
      expect(await rows('SELECT state FROM payout_transfers WHERE id=2')).toEqual([
        { state: 'planned' },
      ])
      expect(await rows('SELECT * FROM wise_transition_audit WHERE payout_id=2')).toEqual([])
      await run('DELETE FROM wise_fault')
      await deliver(pending)
      expect((await store.historyForTransfer('49983982'))[0]).toMatchObject({
        receivedAt: received,
        processedAt: clock,
        skippedReason: null,
      })
      expect(await rows('SELECT state FROM payout_transfers WHERE id=2')).toEqual([
        { state: 'sent' },
      ])
      expect(await rows('SELECT * FROM wise_transition_audit WHERE payout_id=2')).toHaveLength(1)

      // Even an internal mismatch under one digest cannot rewrite pending evidence.
      const mismatch = event(49983983)
      const mismatches = [
        { subscriptionId: 'different' },
        { eventType: 'balances#credit' },
        { transferId: '49983999' },
        { currentState: 'processing' },
        { occurredAt: '2026-10-22T00:00:00.000Z' },
      ]
      for (const [index, changes] of mismatches.entries()) {
        const payload = mismatch + ' '.repeat(index + 1)
        await store.claim({
          deliveryId: key(payload),
          subscriptionId: 'fixture',
          eventType: 'transfers#state-change',
          transferId: '49983983',
          currentState: 'outgoing_payment_sent',
          occurredAt: received,
          now: received,
          ...changes,
        })
        const before = await db.all(
          sql`SELECT * FROM wise_signed_webhook_deliveries WHERE delivery_id=${key(payload)}`,
        )
        await expect(deliver(payload)).rejects.toThrow(/identity/)
        expect(
          await db.all(
            sql`SELECT * FROM wise_signed_webhook_deliveries WHERE delivery_id=${key(payload)}`,
          ),
        ).toEqual(before)
        expect(await rows('SELECT state FROM payout_transfers WHERE id=3')).toEqual([
          { state: 'planned' },
        ])
      }
      await deliver(event(49983983, 'processing'))
      expect(
        (await store.historyForTransfer('49983983')).find((r) => r.currentState === 'processing'),
      ).toMatchObject({ processedAt: clock, skippedReason: 'state processing is not final' })
      await deliver(event(49983999))
      expect((await store.historyForTransfer('49983999'))[0]).toMatchObject({
        processedAt: clock,
        skippedReason: 'no matching payout transfer or payment run',
      })
      // Modern payment runs have their own transfer IDs and reconcile through
      // a scheduled provider read. A missing legacy payout is not an unmatched run.
      await run(`INSERT INTO payment_runs(id,command_json,name,source_currency,scheduled_at,timezone,state,actor_id,approved_by,created_at,approved_at,request_id)
        VALUES('callback-run','{"items":[]}','Callback fixture','USD','${received}','UTC','approved',1,1,'${received}','${received}','callback-run')`)
      await run(`INSERT INTO payment_run_items(id,run_id,user_id,month,expected_version,name,amount_cents,currency,destination_json,quote_json,max_source_cents,state,next_attempt_at,updated_at,transfer_id)
        VALUES('callback-item','callback-run',2,'2026-10',0,'Synthetic',10000,'USD','{}','{}',10000,'processing','2026-10-25T00:00:00.000Z','${received}','49984000')`)
      const beforeRun = await rows('SELECT * FROM staff_payment_events')
      const callback = event(49984000)
      await deliver(callback)
      expect((await store.historyForTransfer('49984000'))[0]).toMatchObject({
        processedAt: clock,
        skippedReason: 'payment run reconciliation scheduled',
      })
      expect(await rows("SELECT state,next_attempt_at FROM payment_run_items WHERE id='callback-item'")).toEqual([
        { state: 'processing', next_attempt_at: clock },
      ])
      expect(await rows('SELECT * FROM staff_payment_events')).toEqual(beforeRun)
      const runHistory = await store.historyForTransfer('49984000')
      await deliver(callback)
      expect(await store.historyForTransfer('49984000')).toEqual(runHistory)
      expect(await rows('SELECT * FROM staff_payment_events')).toEqual(beforeRun)
      await deliver(event(49983983, 'cancelled'))
      expect(await rows('SELECT state,failure_reason FROM payout_transfers WHERE id=3')).toEqual([
        { state: 'failed', failure_reason: 'wise reported cancelled' },
      ])
      expect(await rows('SELECT * FROM wise_transition_audit WHERE payout_id=3')).toHaveLength(1)
      const unsupported = JSON.stringify({
        data: { amount: 100, currency: 'USD', occurred_at: received },
        subscription_id: 'fixture',
        event_type: 'balances#credit',
        sent_at: received,
      })
      await deliver(unsupported)
      expect(
        await db.all(
          sql`SELECT transfer_id,processed_at,skipped_reason FROM wise_signed_webhook_deliveries WHERE delivery_id=${key(unsupported)}`,
        ),
      ).toEqual([
        {
          transfer_id: null,
          processed_at: clock,
          skipped_reason: 'event type balances#credit is not acted on',
        },
      ])
      expect(await rows('SELECT * FROM wise_transition_audit')).toHaveLength(3)
      expect(providerFetch).not.toHaveBeenCalled()
    } finally {
      sqlite?.close()
      await mf?.dispose()
    }
  }, 60000)
}
