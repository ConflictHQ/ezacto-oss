import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createContainerSessionStore,
  createD1SessionStore,
  type SessionStore,
} from '../src/sessions.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  store: SessionStore
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

for (const [runtime, factory] of factories) {
  describe(`session store (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory()
    })

    afterAll(async () => harness.close())

    it('[unit] enforces idle and absolute expiry independently', async () => {
      const idle = await harness.store.issue(1)
      expect(idle.token).toMatch(/^ezacto_session_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)
      expect(idle.session).toMatchObject({
        createdAt: '2026-08-28T00:00:00.000Z',
        idleExpiresAt: '2026-08-28T12:00:00.000Z',
        absoluteExpiresAt: '2026-08-29T00:00:00.000Z',
      })
      harness.setNow('2026-08-28T12:00:00.000Z')
      await expect(harness.store.authenticate(idle.token)).resolves.toBeNull()

      harness.setNow('2026-08-30T00:00:00.000Z')
      const absolute = await harness.store.issue(1)
      harness.setNow('2026-08-30T11:00:00.000Z')
      await expect(harness.store.authenticate(absolute.token)).resolves.toMatchObject({
        session: {
          idleExpiresAt: '2026-08-30T23:00:00.000Z',
          absoluteExpiresAt: '2026-08-31T00:00:00.000Z',
        },
      })
      harness.setNow('2026-08-30T22:00:00.000Z')
      await expect(harness.store.authenticate(absolute.token)).resolves.toMatchObject({
        session: {
          idleExpiresAt: '2026-08-31T00:00:00.000Z',
          absoluteExpiresAt: '2026-08-31T00:00:00.000Z',
        },
      })
      harness.setNow('2026-08-31T00:00:00.000Z')
      await expect(harness.store.authenticate(absolute.token)).resolves.toBeNull()
    })

    it('[api] rotates on privilege change and kills the old cookie', async () => {
      harness.setNow('2026-09-01T00:00:00.000Z')
      const original = await harness.store.issue(2)
      await harness.execute(
        `UPDATE users SET profile = 'accounting', manager_grants = '["team:finance"]',
          updated_at = ? WHERE id = 2`,
        '2026-09-01T00:01:00.000Z',
      )
      harness.setNow('2026-09-01T00:02:00.000Z')
      const attempts = await Promise.all([
        harness.store.authenticate(original.token),
        harness.store.authenticate(original.token),
      ])
      expect(attempts.filter((attempt) => attempt !== null)).toHaveLength(1)
      const rotated = attempts.find((attempt) => attempt !== null)
      expect(rotated).toMatchObject({
        principal: {
          userId: 2,
          profile: 'accounting',
          managerGrants: ['team:finance'],
        },
      })
      expect(rotated?.rotatedToken).toMatch(/^ezacto_session_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)
      expect(rotated?.rotatedToken).not.toBe(original.token)
      await expect(harness.store.authenticate(original.token)).resolves.toBeNull()
      await expect(harness.store.authenticate(rotated!.rotatedToken!)).resolves.toMatchObject({
        principal: { profile: 'accounting', managerGrants: ['team:finance'] },
      })

      const oldRows = await harness.rows<{
        revokedAt: string | null
        revocationReason: string | null
        rotationNonce: string | null
      }>(
        `SELECT revoked_at AS revokedAt, revocation_reason AS revocationReason,
          rotation_nonce AS rotationNonce FROM sessions WHERE id = ?`,
        original.session.id,
      )
      expect(oldRows).toEqual([
        {
          revokedAt: '2026-09-01T00:02:00.000Z',
          revocationReason: 'privilege_change',
          rotationNonce: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
        },
      ])
    })

    it('[api] lists and revokes only the acting user session', async () => {
      harness.setNow('2026-09-02T00:00:00.000Z')
      const issued = await harness.store.issue(1)
      const listed = await harness.store.list(1)
      expect(listed.some(({ id }) => id === issued.session.id)).toBe(true)
      await expect(harness.store.revoke(2, issued.session.id)).resolves.toBeNull()
      await expect(harness.store.authenticate(issued.token)).resolves.not.toBeNull()
      await expect(harness.store.revoke(1, issued.session.id)).resolves.toMatchObject({
        id: issued.session.id,
        revokedAt: '2026-09-02T00:00:00.000Z',
        revocationReason: 'user_revoked',
      })
      await expect(harness.store.authenticate(issued.token)).resolves.toBeNull()

      await expect(
        harness.execute(`UPDATE sessions SET selector = ? WHERE id = ?`, 'A'.repeat(16), 1),
      ).rejects.toThrow(/immutable/i)
    })
  })
}
