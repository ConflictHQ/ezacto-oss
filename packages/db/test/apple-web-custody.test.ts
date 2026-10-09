import { appleLifecycleMigration } from '../src/migrations/0104_apple_lifecycle.js'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerAppleWebCustodyStore, createD1AppleWebCustodyStore, type AppleWebConnection } from '../src/apple-web-custody.js'
import { appleWebCustodyMigration } from '../src/migrations/0105_apple_web_custody.js'

const now = '2026-10-09T03:00:00.000Z'
const connection = (overrides: Partial<AppleWebConnection> = {}): AppleWebConnection => ({
  id: 'c'.repeat(43), subjectDigest: 'a'.repeat(64), browserHash: 'b'.repeat(64), userId: 1,
  serviceIssuer: 'https://apple-auth.ezacto.com', instanceOrigin: 'https://app.example.com', clientId: 'com.ezacto.web',
  grantId: 'grant_0001', generation: 1, sealedCapability: '{"kid":"test","ciphertext":"encrypted"}',
  sealedReceipt: null, cleanupRequestId: null, status: 'active', createdAt: now, updatedAt: now, ...overrides,
})
const schema = ['CREATE TABLE account_closure_security(id INTEGER PRIMARY KEY, secret TEXT NOT NULL)', "INSERT INTO account_closure_security VALUES(1,'" + 'ab'.repeat(32) + "')",
  'CREATE TABLE user_identities(user_id INTEGER, provider TEXT, provider_subject TEXT)', "INSERT INTO user_identities VALUES(1,'apple','subject-1'),(2,'apple','subject-2')",
  appleLifecycleMigration[0],
  'CREATE TABLE users(id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL) STRICT', 'INSERT INTO users VALUES(1,1),(2,1)', ...appleWebCustodyMigration]
for (const runtime of ['container', 'D1'] as const) {
  describe(`web Apple custody (${runtime})`, () => {
    const cleanups: (() => Promise<void>)[] = []
    afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
    const harness = async () => {
      if (runtime === 'container') {
        const db = new BetterSqlite3(':memory:')
        db.pragma('foreign_keys = ON')
        for (const sql of schema) db.exec(sql)
        cleanups.push(async () => { db.close() })
        const store = createContainerAppleWebCustodyStore(db)
        return { ...store, save: (input: AppleWebConnection) => store.save(input, input.userId === null ? undefined : { subject: 'subject-' + input.userId, knownFromFirstLink: true }) }
      }
      const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] })
      cleanups.push(() => mf.dispose())
      const db = await mf.getD1Database('DB')
      for (const sql of schema) await db.prepare(sql).run()
      const store = createD1AppleWebCustodyStore(db)
      return { ...store, save: (input: AppleWebConnection) => store.save(input, input.userId === null ? undefined : { subject: 'subject-' + input.userId, knownFromFirstLink: true }) }
    }
    it('rotates browser recovery independently of sessions and rejects older generations', async () => {
      const store = await harness(), first = connection()
      await store.save(first)
      const second = { ...first, id: 'd'.repeat(43), browserHash: 'd'.repeat(64), grantId: 'grant_0002', generation: 2 }
      expect((await store.save(second))?.id).toBe(first.id)
      expect(await store.browser(first.browserHash)).toBeNull()
      expect((await store.browser(second.browserHash))?.grantId).toBe(second.grantId)
      expect(await store.save(first)).toBeNull()
    })
    it('never attaches demo custody to the shared member account', async () => {
      const store = await harness()
      const demo = connection({ clientId: 'com.ezacto.web.demo', instanceOrigin: 'https://ezacto.io' })
      await expect(store.save(demo)).rejects.toThrow()
      await store.save({ ...demo, userId: null })
      await store.begin(1, 'request_001', now)
      expect(await store.status('request_001')).toBe('not_linked')
      expect((await store.browser(demo.browserHash))?.userId).toBeNull()
    })
    it('captures obligations, refuses mismatched proof, and preserves unresolved cleanup', async () => {
      const store = await harness(), input = connection()
      await store.save(input)
      await store.begin(1, 'request_001', now)
      expect(await store.status('request_001')).toBe('pending')
      expect(await store.status('unknown_001')).toBe('manual_required')
      const proof = { id: input.id, requestId: 'request_001', grantId: input.grantId, generation: input.generation, sealedReceipt: '{"encrypted":"receipt"}', now }
      expect(await store.complete({ ...proof, generation: 2 })).toBe(false)
      expect(await store.complete({ ...proof, requestId: 'different_001' })).toBe(false)
      await store.manual(input.id, now)
      expect(await store.status('request_001')).toBe('manual_required')
      expect(await store.complete(proof)).toBe(true)
      expect(await store.status('request_001')).toBe('revoked')
      expect(await store.browser(input.browserHash)).toBeNull()
    })
    it('accepts request-bound newer custody without discharging an obligation early', async () => {
      const store = await harness(), first = connection()
      await store.save(first)
      await store.begin(1, 'request_001', now)
      expect(await store.save({ ...first, generation: 2 })).toBeNull()
      const rebound = { ...first, userId: null, generation: 2, grantId: 'grant_0002', browserHash: 'd'.repeat(64), cleanupRequestId: 'request_001' }
      expect((await store.save(rebound))?.userId).toBe(1)
      expect(await store.status('request_001')).toBe('pending')
      expect(await store.complete({ id: first.id, requestId: 'request_001', grantId: first.grantId, generation: 1, sealedReceipt: '{}', now })).toBe(false)
      expect(await store.complete({ id: first.id, requestId: 'request_001', grantId: rebound.grantId, generation: 2, sealedReceipt: '{"ciphertext":"receipt"}', now })).toBe(true)
      expect(await store.status('request_001')).toBe('revoked')
    })
    it('recovers a failed browser disconnect for a later account deletion only with newer request-bound custody', async () => {
      const store = await harness(), first = connection()
      await store.save(first)
      await store.pending(first.id, 'browser_disconnect', now)
      await store.begin(1, 'request_001', now)
      expect(await store.status('request_001')).toBe('manual_required')
      expect(await store.save({ ...first, userId: null, cleanupRequestId: 'request_001' })).toBeNull()
      const recovered = await store.save({ ...first, userId: null, generation: 2, grantId: 'grant_0002', cleanupRequestId: 'request_001' })
      expect(recovered?.cleanupRequestId).toBe('request_001')
      expect(await store.status('request_001')).toBe('pending')
      expect(await store.complete({ id: first.id, requestId: 'browser_disconnect', grantId: first.grantId, generation: 1, sealedReceipt: '{}', now })).toBe(false)
    })
    it('rejects a different Apple subject recovering a captured deletion request', async () => {
      const store = await harness(), first = connection()
      await store.save(first)
      await store.begin(1, 'request_001', now)
      expect(await store.save(connection({ id: 'e'.repeat(43), subjectDigest: 'e'.repeat(64), browserHash: 'e'.repeat(64), userId: null, cleanupRequestId: 'request_001' }))).toBeNull()
      expect(await store.status('request_001')).toBe('pending')
      expect(await store.obligations('request_001')).toHaveLength(1)
    })
    it('blocks account binding after obligations were captured', async () => {
      const store = await harness()
      await store.begin(1, 'request_001', now)
      expect(await store.save(connection())).toBeNull()
      expect(await store.status('request_001')).toBe('not_linked')
      expect(await store.save(connection({ userId: 2 }))).not.toBeNull()
    })
    it('allows fresh sign-in after a completed explicit disconnect', async () => {
      const store = await harness(), first = connection()
      await store.save(first)
      await store.pending(first.id, 'disconnect_001', now)
      await store.complete({ id: first.id, requestId: 'disconnect_001', grantId: first.grantId, generation: 1, sealedReceipt: '{}', now })
      const fresh = { ...first, id: 'f'.repeat(43), browserHash: 'f'.repeat(64), generation: 2 }
      expect((await store.save(fresh))?.cleanupRequestId).toBeNull()
    })
  })
}
