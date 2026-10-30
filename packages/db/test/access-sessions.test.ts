import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createContainerSessionStore,
  createD1SessionStore,
  type SessionStore,
  type SessionStoreOptions,
} from '../src/sessions.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  store: SessionStore
  /** A second store over the same database, with its own options. */
  storeWith(options: Omit<SessionStoreOptions, 'now'>): SessionStore
  setNow(value: string): void
  execute(query: string, ...bindings: unknown[]): Promise<void>
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const initialTime = '2026-08-28T00:00:00.000Z'
const idleTtlMs = 12 * 60 * 60 * 1_000
const absoluteTtlMs = 24 * 60 * 60 * 1_000

const seedStatements = [
  {
    query: `INSERT INTO organizations (id, name, modules, created_at, updated_at)
      VALUES (1, 'Session Test', '{}', ?, ?)`,
    bindings: [initialTime, initialTime],
  },
  {
    query: `INSERT INTO users (
        id, first_name, last_name, timezone, is_contractor, is_active,
        has_access_to_all_future_projects, weekly_capacity, profile,
        manager_grants, is_owner, saml_exempt, created_at, updated_at
      ) VALUES (
        1, 'Avery', 'Ng', 'UTC', 0, 1, 1, 126000,
        'administrator', '[]', 0, 0, ?, ?
      )`,
    bindings: [initialTime, initialTime],
  },
  {
    query: `INSERT INTO users (
        id, first_name, last_name, timezone, is_contractor, is_active,
        has_access_to_all_future_projects, weekly_capacity, profile,
        manager_grants, is_owner, saml_exempt, created_at, updated_at
      ) VALUES (
        2, 'Morgan', 'Lee', 'UTC', 0, 1, 0, 126000,
        'member', '[]', 0, 0, ?, ?
      )`,
    bindings: [initialTime, initialTime],
  },
] as const

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  for (const statement of seedStatements) {
    database.prepare(statement.query).run(...statement.bindings)
  }
  let currentTime = initialTime
  return {
    store: createContainerSessionStore(database, {
      now: () => currentTime,
      idleTtlMs,
      absoluteTtlMs,
    }),
    storeWith: (options) =>
      createContainerSessionStore(database, { now: () => currentTime, ...options }),
    setNow: (value) => {
      currentTime = value
    },
    execute: async (query, ...bindings) => {
      database.prepare(query).run(...bindings)
    },
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      database.prepare(query).all(...bindings) as T[],
    close: async () => {
      database.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  for (const statement of seedStatements) {
    await database
      .prepare(statement.query)
      .bind(...statement.bindings)
      .run()
  }
  let currentTime = initialTime
  return {
    store: createD1SessionStore(database, {
      now: () => currentTime,
      idleTtlMs,
      absoluteTtlMs,
    }),
    storeWith: (options) => createD1SessionStore(database, { now: () => currentTime, ...options }),
    setNow: (value) => {
      currentTime = value
    },
    execute: async (query, ...bindings) => {
      await database
        .prepare(query)
        .bind(...bindings)
        .run()
    },
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(query)
          .bind(...bindings)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories)
  describe(`Access assertion sessions (${runtime})`, () => {
    let h: Harness
    beforeAll(async () => {
      h = await factory()
    }, 60000)
    afterAll(async () => h.close())
    it('atomically shares one row across distinct stores and returns only the winning random bearer', async () => {
      h.setNow(initialTime)
      const selector = 'A'.repeat(16)
      const stores = Array.from({ length: 8 }, () => h.storeWith({ idleTtlMs, absoluteTtlMs }))
      const results = await Promise.all(
        stores.map((store) => store.authenticateAccess(2, selector)),
      )
      expect(results.every((result) => result?.principal.userId === 2)).toBe(true)
      expect(new Set(results.map((result) => result!.session.id)).size).toBe(1)
      expect(results.filter((result) => result?.issuedToken)).toHaveLength(1)
      const token = results.find((result) => result?.issuedToken)!.issuedToken!
      expect(token).toMatch(/^ezacto_session_A{16}_[A-Za-z0-9_-]{43}$/)
      expect(token.split('_').at(-1)).not.toBe(selector)
      expect(await h.store.authenticate(token)).toMatchObject({ principal: { userId: 2 } })
      expect(await h.store.authenticateAccess(1, selector)).toBeNull()
      expect(await h.rows('SELECT id FROM sessions WHERE selector=?', selector)).toHaveLength(1)
    })
    it('does not recreate revoked assertions and accepts a fresh assertion after revoke-all', async () => {
      h.setNow(initialTime)
      const first = await h.store.authenticateAccess(2, 'B'.repeat(16))
      await h.store.revoke(2, first!.session.id)
      expect(await h.store.authenticateAccess(2, 'B'.repeat(16))).toBeNull()
      expect(await h.rows('SELECT id FROM sessions WHERE selector=?', 'B'.repeat(16))).toHaveLength(
        1,
      )
      const fresh = await h.store.authenticateAccess(2, 'C'.repeat(16))
      expect(fresh?.issuedToken).toBeDefined()
      await h.store.revokeAll(2)
      expect(await h.store.authenticateAccess(2, 'C'.repeat(16))).toBeNull()
      expect((await h.store.authenticateAccess(2, 'D'.repeat(16)))?.issuedToken).toBeDefined()
    })
    it('preserves expiry without extending the absolute limit or recreating expired sessions', async () => {
      h.setNow(initialTime)
      const first = await h.store.authenticateAccess(2, 'E'.repeat(16))
      h.setNow('2026-08-28T11:00:00.000Z')
      const active = await h.store.authenticateAccess(2, 'E'.repeat(16))
      expect(active?.session.id).toBe(first?.session.id)
      expect(active?.session.absoluteExpiresAt).toBe(first?.session.absoluteExpiresAt)
      h.setNow('2026-08-29T00:00:00.000Z')
      expect(await h.store.authenticateAccess(2, 'E'.repeat(16))).toBeNull()
      expect(await h.rows('SELECT id FROM sessions WHERE selector=?', 'E'.repeat(16))).toHaveLength(
        1,
      )
    })
    it('retains native role rotation and disabled-user refusal', async () => {
      h.setNow(initialTime)
      await h.store.authenticateAccess(2, 'F'.repeat(16))
      await h.execute("UPDATE users SET profile='accounting' WHERE id=2")
      const changed = await h.store.authenticateAccess(2, 'F'.repeat(16))
      expect(changed).toMatchObject({ principal: { userId: 2, profile: 'accounting' } })
      expect(changed?.rotatedToken).toBeDefined()
      expect(await h.store.authenticateAccess(2, 'F'.repeat(16))).toBeNull()
      expect(await h.store.authenticate(changed!.rotatedToken!)).toMatchObject({
        principal: { profile: 'accounting' },
      })
      await h.execute('UPDATE users SET is_active=0 WHERE id=2')
      expect(await h.store.authenticateAccess(2, 'G'.repeat(16))).toBeNull()
      expect(await h.rows('SELECT id FROM sessions WHERE selector=?', 'G'.repeat(16))).toHaveLength(
        0,
      )
    })
  })
