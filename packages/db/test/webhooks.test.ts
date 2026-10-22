import Database from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWebhookSecretVault,
  verifyWebhookSignature,
  type WebhookTransport,
} from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { atomic, nativeClient, type ActivityDatabase } from '../src/activity-log.js'
import { createWebhookService } from '../src/webhooks.js'

for (const runtime of ['SQLite', 'D1'] as const)
  describe(`outbound webhooks (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async (transport: WebhookTransport) => {
      let database: ActivityDatabase
      if (runtime === 'SQLite') {
        const sqlite = new Database(':memory:')
        migrateContainer(sqlite)
        database = createContainerDatabase(sqlite)
        close = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const d1 = await mf.getD1Database('DB')
        await migrateD1(d1)
        database = createD1Database(d1)
        close = async () => mf.dispose()
      }
      const client = nativeClient(database)
      const query = async <T>(sql: string, ...params: unknown[]) =>
        (await atomic(client, [{ sql, params }]))[0] as T[]
      let now = new Date().toISOString(),
        eventIndex = 0
      await query(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES
      (1,'Owner','Fixture','administrator','[]',?,?),(2,'Member','Fixture','member','[]',?,?),(3,'Admin','Fixture','administrator','[]',?,?)`,
        ...Array(6).fill(now),
      )
      const vault = await createWebhookSecretVault('A'.repeat(43))
      const service = createWebhookService(database, { vault, transport, clock: () => now })
      const emit = async () => {
        const id = crypto.randomUUID(),
          resource = 100 + ++eventIndex,
          eventType = 'time_entry.deleted_on_behalf'
        const payload = JSON.stringify({
          schema_version: 1,
          event_id: id,
          event_type: eventType,
          occurred_at: now,
          aggregate: { type: 'time_entry', id: resource, sequence: 1 },
          actor: { type: 'user', id: 1 },
          time_entry: {
            user_id: 2,
            before: { id: resource, notes: 'PRIVATE_SOURCE_NOTE', rate_cents: 98765 },
            after: null,
          },
        })
        const sql = `INSERT OR IGNORE INTO event_outbox(id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at) VALUES(?,'time_entry',?,1,?,?,?,?)`
        const params = [id, resource, eventType, payload, now, now]
        await query(sql, ...params)
        return { id, repeat: () => query(sql, ...params) }
      }
      return {
        database,
        query,
        vault,
        service,
        emit,
        clock: () => now,
        advance: (seconds: number) => {
          now = new Date(Date.parse(now) + seconds * 1000).toISOString()
        },
      }
    }
    const events = ['time_entry.deleted_on_behalf']
    it('[security #107] captures only future subscribed events, deduplicates fanout, and keeps keys private', async () => {
      const f = await setup({ send: async () => ({ status: 200 }) })
      await f.emit()
      const a = await f.service.create(1, { url: 'https://hooks.example.com/a', events })
      const b = await f.service.create(1, { url: 'https://hooks.example.com/b', events })
      const paused = await f.service.create(1, { url: 'https://hooks.example.com/paused', events })
      await f.service.setActive(1, paused.subscription.id, false, 0)
      expect(await f.service.countDeliveries({})).toBe(0)
      const event = await f.emit()
      await expect(event.repeat()).rejects.toThrow('outbox event identity already exists')
      const deliveries = await f.query<{ subscription_id: string; payload_json: string }>(
        'SELECT subscription_id,payload_json FROM webhook_deliveries',
      )
      expect(deliveries.map((row) => row.subscription_id).sort()).toEqual(
        [a.subscription.id, b.subscription.id].sort(),
      )
      expect(await f.service.processDue()).toMatchObject({ delivered: 2 })
      expect(await f.service.processDue()).toMatchObject({ examined: 0 })
      expect(await f.service.countDeliveries({})).toBe(2)
      for (const row of deliveries) {
        expect(row.payload_json).not.toContain('PRIVATE_SOURCE_NOTE')
        expect(row.payload_json).not.toContain('98765')
      }
      const publicData = JSON.stringify(await f.service.list())
      expect(publicData).not.toContain(a.secret)
      expect(publicData).not.toContain('ciphertext')
      expect(publicData).not.toContain('current_secret')
      const stored = JSON.stringify(await f.query('SELECT * FROM webhook_subscriptions'))
      expect(stored).not.toContain(a.secret)
      expect(stored).not.toContain(b.secret)
      const audit = JSON.stringify(
        await f.query("SELECT payload_json FROM event_outbox WHERE event_type LIKE 'webhook_%'"),
      )
      expect(audit).not.toContain(a.secret)
      expect(audit).not.toContain('ciphertext')
      await expect(
        f.service.create(2, { url: 'https://hooks.example.com/member', events }),
      ).rejects.toMatchObject({ code: 'webhook_forbidden' })
    })
    it('[delivery #107] isolates failing endpoints, rotates with overlap and replays identical signed payloads', async () => {
      const sent: Parameters<WebhookTransport['send']>[0][] = []
      let failing = true
      const f = await setup({
        send: async (request) => {
          sent.push(request)
          return { status: request.url.endsWith('/fails') && failing ? 503 : 200 }
        },
      })
      const a = await f.service.create(1, { url: 'https://hooks.example.com/fails', events })
      await f.service.create(1, { url: 'https://hooks.example.com/ok', events })
      await f.emit()
      expect(await f.service.processDue()).toMatchObject({ delivered: 1, retried: 1, failed: 0 })
      const original = sent.find((request) => request.url.endsWith('/fails'))!
      const rotated = await f.service.rotate(1, a.subscription.id, { version: 0 })
      expect(rotated.subscription.generation).toBe(2)
      await expect(f.service.rotate(1, a.subscription.id, { version: 1 })).rejects.toMatchObject({
        code: 'webhook_rotation_overlap_active',
      })
      failing = false
      f.advance(61)
      expect(await f.service.processDue()).toMatchObject({ delivered: 1, retried: 0 })
      const retried = sent.filter((request) => request.url.endsWith('/fails')).at(-1)!
      expect(retried.eventId).toBe(original.eventId)
      expect(retried.body).toBe(original.body)
      for (const secret of [a.secret, rotated.secret])
        expect(
          await verifyWebhookSignature({
            body: new TextEncoder().encode(retried.body),
            timestamp: retried.timestamp,
            signature: retried.signature,
            secrets: [secret],
            now: Date.parse(f.clock()) / 1000,
          }),
        ).toBe(true)
      const delivery = (
        await f.service.pageDeliveries({
          subscriptionId: a.subscription.id,
          after: null,
          createdThrough: '9999-01-01T00:00:00.000Z',
          take: 10,
        })
      )[0]!
      await f.service.replay(1, delivery.id)
      await f.service.processDue()
      const replay = sent.at(-1)!
      expect(replay.eventId).toBe(original.eventId)
      expect(replay.body).toBe(original.body)
      expect((await f.service.delivery(delivery.id))!.replayCount).toBe(1)
      f.advance(901)
      await f.service.purge()
      await f.emit()
      await f.service.processDue()
      const fresh = sent.filter((request) => request.url.endsWith('/fails')).at(-1)!
      expect(fresh.signature).not.toContain(',')
      expect(
        await verifyWebhookSignature({
          body: new TextEncoder().encode(fresh.body),
          timestamp: fresh.timestamp,
          signature: fresh.signature,
          secrets: [a.secret],
          now: Date.parse(f.clock()) / 1000,
        }),
      ).toBe(false)
      const latest = (await f.service.get(a.subscription.id))!
      await f.service.remove(1, a.subscription.id, latest.version)
      const removed = (
        await f.query<{ current_secret: null; previous_secret: null }>(
          'SELECT current_secret,previous_secret FROM webhook_subscriptions WHERE id=?',
          a.subscription.id,
        )
      )[0]!
      expect(removed.current_secret).toBeNull()
      expect(removed.previous_secret).toBeNull()
    })
    it('[crash #107] fences a late response after lease takeover and terminates an abandoned last attempt', async () => {
      let enter!: () => void,
        release!: (value: { status: number }) => void,
        count = 0
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const held = new Promise<{ status: number }>((resolve) => {
        release = resolve
      })
      const f = await setup({
        send: async () => {
          if (++count === 1) {
            enter()
            return held
          }
          return { status: 200 }
        },
      })
      const sub = await f.service.create(1, { url: 'https://hooks.example.com/slow', events })
      await f.emit()
      const first = f.service.processDue()
      await entered
      expect(await f.service.processDue()).toMatchObject({ examined: 0 })
      f.advance(31)
      expect(await f.service.processDue()).toMatchObject({ delivered: 1 })
      release({ status: 200 })
      expect(await first).toMatchObject({ contention: 1 })
      const delivery = (
        await f.service.pageDeliveries({
          subscriptionId: sub.subscription.id,
          after: null,
          createdThrough: '9999-01-01T00:00:00.000Z',
          take: 10,
        })
      )[0]!
      expect(delivery).toMatchObject({ status: 'delivered', attemptCount: 2 })
      await f.emit()
      await f.query(
        "UPDATE webhook_deliveries SET status='processing',attempt_count=5,cycle_attempts=5,lease_token='abandoned-fixture',lease_expires_at=? WHERE status='pending'",
        f.clock(),
      )
      expect(await f.service.processDue()).toMatchObject({ failed: 1, examined: 0 })
      expect(
        (
          await f.query<{ last_error_code: string }>(
            "SELECT last_error_code FROM webhook_deliveries WHERE status='failed'",
          )
        )[0]!.last_error_code,
      ).toBe('attempt_abandoned')
    })
    it('[concurrency #107] rejects stale versions, a demoted actor and plaintext secret storage', async () => {
      const f = await setup({ send: async () => ({ status: 200 }) })
      const created = await f.service.create(1, { url: 'https://hooks.example.com/admin', events })
      await f.service.setActive(1, created.subscription.id, false, 0)
      await expect(f.service.setActive(1, created.subscription.id, true, 0)).rejects.toMatchObject({
        code: 'webhook_conflict',
      })
      const demoting = createWebhookService(f.database, {
        transport: { send: async () => ({ status: 200 }) },
        clock: f.clock,
        vault: {
          ...f.vault,
          seal: async (secret, identity) => {
            const cipher = await f.vault.seal(secret, identity)
            await f.query("UPDATE users SET profile='member' WHERE id=3")
            return cipher
          },
        },
      })
      await expect(
        demoting.create(3, { url: 'https://hooks.example.com/demoted', events }),
      ).rejects.toMatchObject({ code: 'webhook_forbidden' })
      expect(await f.service.list()).toHaveLength(1)
      await expect(
        f.query(
          "UPDATE webhook_subscriptions SET generation=generation+1,current_secret='{}' WHERE id=?",
          created.subscription.id,
        ),
      ).rejects.toThrow()
      await expect(
        f.query(
          'UPDATE webhook_subscriptions SET generation=generation+1,current_secret=? WHERE id=?',
          JSON.stringify(created.secret),
          created.subscription.id,
        ),
      ).rejects.toThrow()
    })
    it('[delivery #107] bounds retry cycles, replay age and retention; missing configuration fails closed', async () => {
      const sent: string[] = []
      const f = await setup({
        send: async (input) => {
          sent.push(input.body)
          return { status: 503 }
        },
      })
      await f.service.create(1, { url: 'https://hooks.example.com/retries', events })
      await f.emit()
      for (let attempt = 0; attempt < 5; attempt++) {
        const outcome = await f.service.processDue()
        expect(outcome).toMatchObject(attempt < 4 ? { retried: 1 } : { failed: 1 })
        expect((await f.service.processDue()).examined).toBe(0)
        f.advance([60, 300, 900, 3600, 1][attempt]!)
      }
      expect(sent).toHaveLength(5)
      expect(new Set(sent).size).toBe(1)
      const delivery = (
        await f.service.pageDeliveries({
          after: null,
          createdThrough: '9999-01-01T00:00:00.000Z',
          take: 10,
        })
      )[0]!
      expect(delivery).toMatchObject({ status: 'failed', attemptCount: 5, lastStatus: 503 })
      const unavailable = createWebhookService(f.database, {
        vault: null,
        transport: { send: async () => ({ status: 200 }) },
        clock: f.clock,
      })
      await expect(
        unavailable.create(1, { url: 'https://hooks.example.com/unconfigured', events }),
      ).rejects.toMatchObject({ code: 'webhook_secret_unavailable' })
      await expect(unavailable.replay(1, delivery.id)).rejects.toMatchObject({
        code: 'webhook_secret_unavailable',
      })
      f.advance(8 * 86400)
      await expect(f.service.replay(1, delivery.id)).rejects.toMatchObject({
        code: 'webhook_replay_expired',
      })
      expect((await f.service.purge()).removed).toBe(0)
      f.advance(23 * 86400)
      expect((await f.service.purge()).removed).toBe(1)
      expect(await f.service.delivery(delivery.id)).toBeNull()
    })
  })
