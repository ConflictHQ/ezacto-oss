import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createContainerSessionStore,
  createD1SessionStore,
  LAST_SEEN_INTERVAL_MS,
  lastSeenIntervalFromSeconds,
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
    storeWith: (options) =>
      createD1SessionStore(database, { now: () => currentTime, ...options }),
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
        harness.execute(
          `UPDATE sessions SET selector = ? WHERE id = ?`,
          'A'.repeat(16),
          issued.session.id,
        ),
      ).rejects.toThrow(/immutable/i)

      const [stored] = await harness.rows<{ selector: string }>(
        `SELECT selector FROM sessions WHERE id = ?`,
        issued.session.id,
      )
      expect(stored).toBeDefined()
      const replacement = `INSERT OR REPLACE INTO sessions (
          id, user_id, selector, secret_hash, profile_snapshot,
          manager_grants_snapshot, created_at, last_seen_at,
          idle_expires_at, absolute_expires_at, revoked_at,
          revocation_reason, rotation_nonce, updated_at
        )
        SELECT ?, user_id, ?, secret_hash, profile_snapshot,
          manager_grants_snapshot, created_at, last_seen_at,
          idle_expires_at, absolute_expires_at, NULL, NULL, NULL, ?
        FROM sessions WHERE id = ?`
      await expect(
        harness.execute(
          replacement,
          issued.session.id,
          stored!.selector,
          '2026-09-02T00:01:00.000Z',
          issued.session.id,
        ),
      ).rejects.toThrow(/collision cannot replace/i)
      await expect(
        harness.execute(
          replacement,
          issued.session.id,
          'Z'.repeat(16),
          '2026-09-02T00:01:00.000Z',
          issued.session.id,
        ),
      ).rejects.toThrow(/id collision cannot replace/i)
      await expect(
        harness.execute(
          replacement,
          issued.session.id + 10_000,
          stored!.selector,
          '2026-09-02T00:01:00.000Z',
          issued.session.id,
        ),
      ).rejects.toThrow(/selector collision cannot replace/i)
      await expect(harness.store.authenticate(issued.token)).resolves.toBeNull()
    })

    it('[security] accepts an older in-flight authentication without regressing timestamps', async () => {
      harness.setNow('2026-09-03T00:00:00.000Z')
      const issued = await harness.store.issue(1)
      harness.setNow('2026-09-03T02:00:00.000Z')
      const later = await harness.store.authenticate(issued.token)
      expect(later).toMatchObject({
        session: {
          lastSeenAt: '2026-09-03T02:00:00.000Z',
          idleExpiresAt: '2026-09-03T14:00:00.000Z',
        },
      })

      harness.setNow('2026-09-03T01:00:00.000Z')
      const olderInFlight = await harness.store.authenticate(issued.token)
      expect(olderInFlight).toMatchObject({
        session: {
          lastSeenAt: '2026-09-03T02:00:00.000Z',
          idleExpiresAt: '2026-09-03T14:00:00.000Z',
          revokedAt: null,
        },
      })
    })

    // Issue 951. A row-level trigger counts every row an UPDATE actually
    // writes, on either runtime, so "no write" means no row was rewritten --
    // not merely that the values came back the same.
    const countSessionWrites = async (): Promise<() => Promise<number>> => {
      await harness.execute(
        `CREATE TABLE IF NOT EXISTS test_session_writes (session_id INTEGER NOT NULL)`,
      )
      await harness.execute(
        `CREATE TRIGGER IF NOT EXISTS test_session_writes_log AFTER UPDATE ON sessions
          BEGIN INSERT INTO test_session_writes (session_id) VALUES (NEW.id); END`,
      )
      await harness.execute(`DELETE FROM test_session_writes`)
      return async () =>
        (await harness.rows<{ writes: number }>(
          `SELECT count(*) AS writes FROM test_session_writes`,
        ))[0]!.writes
    }

    it('[security] writes last-seen at most once per interval and still reads the session each time', async () => {
      harness.setNow('2026-09-04T00:00:00.000Z')
      const issued = await harness.store.issue(1)
      const writes = await countSessionWrites()

      // Two requests inside the interval: both authenticate, neither writes.
      harness.setNow('2026-09-04T00:01:00.000Z')
      await expect(harness.store.authenticate(issued.token)).resolves.toMatchObject({
        principal: { userId: 1, profile: 'administrator' },
        session: {
          id: issued.session.id,
          lastSeenAt: '2026-09-04T00:00:00.000Z',
          idleExpiresAt: '2026-09-04T12:00:00.000Z',
        },
      })
      harness.setNow('2026-09-04T00:04:59.999Z')
      await expect(harness.store.authenticate(issued.token)).resolves.toMatchObject({
        session: { lastSeenAt: '2026-09-04T00:00:00.000Z' },
      })
      expect(await writes()).toBe(0)

      // The first request once last-seen is the interval old records it, and
      // moves the idle expiry with it exactly as every request used to.
      harness.setNow('2026-09-04T00:05:00.000Z')
      await expect(harness.store.authenticate(issued.token)).resolves.toMatchObject({
        session: {
          lastSeenAt: '2026-09-04T00:05:00.000Z',
          idleExpiresAt: '2026-09-04T12:05:00.000Z',
        },
      })
      expect(await writes()).toBe(1)
      harness.setNow('2026-09-04T00:06:00.000Z')
      await expect(harness.store.authenticate(issued.token)).resolves.not.toBeNull()
      expect(await writes()).toBe(1)
      expect(LAST_SEEN_INTERVAL_MS).toBe(5 * 60 * 1_000)
    })

    it('[security] keeps idle expiry measured from the last recorded activity', async () => {
      harness.setNow('2026-09-05T00:00:00.000Z')
      const issued = await harness.store.issue(1)
      harness.setNow('2026-09-05T00:04:00.000Z')
      await expect(harness.store.authenticate(issued.token)).resolves.not.toBeNull()
      // Idle for the whole window since the last write: expired, as before.
      // An unrecorded request inside the interval never extends a session.
      harness.setNow('2026-09-05T12:00:00.000Z')
      await expect(harness.store.authenticate(issued.token)).resolves.toBeNull()

      harness.setNow('2026-09-06T00:00:00.000Z')
      const touched = await harness.store.issue(1)
      harness.setNow('2026-09-06T06:00:00.000Z')
      await expect(harness.store.authenticate(touched.token)).resolves.toMatchObject({
        session: { idleExpiresAt: '2026-09-06T18:00:00.000Z' },
      })
      // Read inside the interval: the expiry stays where the 06:00 write put
      // it, so the window can close up to one interval early, never late.
      harness.setNow('2026-09-06T06:04:00.000Z')
      await expect(harness.store.authenticate(touched.token)).resolves.toMatchObject({
        session: { idleExpiresAt: '2026-09-06T18:00:00.000Z' },
      })
      harness.setNow('2026-09-06T17:59:59.999Z')
      await expect(harness.store.authenticate(touched.token)).resolves.toMatchObject({
        session: { idleExpiresAt: '2026-09-07T00:00:00.000Z' },
      })
      harness.setNow('2026-09-07T00:00:00.000Z')
      await expect(harness.store.authenticate(touched.token)).resolves.toBeNull()
    })

    it('[security] refuses a revoked, disabled or re-privileged session inside the interval', async () => {
      harness.setNow('2026-09-07T00:00:00.000Z')
      const revoked = await harness.store.issue(1)
      const disabled = await harness.store.issue(2)
      harness.setNow('2026-09-07T00:01:00.000Z')
      await expect(harness.store.revoke(1, revoked.session.id)).resolves.not.toBeNull()
      await expect(harness.store.authenticate(revoked.token)).resolves.toBeNull()

      await harness.execute(
        `UPDATE users SET is_active = 0, updated_at = ? WHERE id = 2`,
        '2026-09-07T00:01:00.000Z',
      )
      harness.setNow('2026-09-07T00:02:00.000Z')
      await expect(harness.store.authenticate(disabled.token)).resolves.toBeNull()
      const [disabledRow] = await harness.rows<{ reason: string | null }>(
        `SELECT revocation_reason AS reason FROM sessions WHERE id = ?`,
        disabled.session.id,
      )
      expect(disabledRow).toEqual({ reason: 'user_disabled' })
      await harness.execute(
        `UPDATE users SET is_active = 1, profile = 'member', updated_at = ? WHERE id = 2`,
        '2026-09-07T00:02:00.000Z',
      )

      // A profile change inside the interval still rotates rather than reading
      // the stale snapshot as current.
      const promoted = await harness.store.issue(2)
      await harness.execute(
        `UPDATE users SET profile = 'people_admin', updated_at = ? WHERE id = 2`,
        '2026-09-07T00:03:00.000Z',
      )
      harness.setNow('2026-09-07T00:03:00.000Z')
      const rotated = await harness.store.authenticate(promoted.token)
      expect(rotated).toMatchObject({ principal: { profile: 'people_admin' } })
      expect(rotated?.rotatedToken).toMatch(/^ezacto_session_/)
      await expect(harness.store.authenticate(promoted.token)).resolves.toBeNull()
      await harness.execute(
        `UPDATE users SET profile = 'member', updated_at = ? WHERE id = 2`,
        '2026-09-07T00:04:00.000Z',
      )
    })

    it('[unit] writes on every request at an interval of zero, and refuses one as long as the idle window', async () => {
      harness.setNow('2026-09-08T00:00:00.000Z')
      const everyRequest = harness.storeWith({ idleTtlMs, absoluteTtlMs, touchIntervalMs: 0 })
      const issued = await everyRequest.issue(1)
      const writes = await countSessionWrites()
      harness.setNow('2026-09-08T00:00:01.000Z')
      await expect(everyRequest.authenticate(issued.token)).resolves.toMatchObject({
        session: { lastSeenAt: '2026-09-08T00:00:01.000Z' },
      })
      harness.setNow('2026-09-08T00:00:02.000Z')
      await expect(everyRequest.authenticate(issued.token)).resolves.toMatchObject({
        session: { lastSeenAt: '2026-09-08T00:00:02.000Z' },
      })
      expect(await writes()).toBe(2)

      expect(() =>
        harness.storeWith({ idleTtlMs, absoluteTtlMs, touchIntervalMs: idleTtlMs }),
      ).toThrow(RangeError)
      expect(() =>
        harness.storeWith({ idleTtlMs, absoluteTtlMs, touchIntervalMs: -1 }),
      ).toThrow(RangeError)
    })
  })
}

describe('LAST_SEEN_INTERVAL_SECONDS', () => {
  it('[unit] defaults when unset and accepts whole seconds up to an hour', () => {
    expect(lastSeenIntervalFromSeconds(undefined)).toBe(5 * 60 * 1_000)
    expect(lastSeenIntervalFromSeconds('  ')).toBe(5 * 60 * 1_000)
    expect(lastSeenIntervalFromSeconds('0')).toBe(0)
    expect(lastSeenIntervalFromSeconds(' 900 ')).toBe(900_000)
    expect(lastSeenIntervalFromSeconds('3600')).toBe(3_600_000)
  })

  it.each(['3601', '-1', '1.5', '5m', '0x10', '1e3', 'NaN'])(
    '[security] refuses %s rather than guessing',
    (value) => {
      expect(() => lastSeenIntervalFromSeconds(value)).toThrow(TypeError)
    },
  )
})
