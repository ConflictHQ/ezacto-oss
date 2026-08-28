import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  authenticateApiToken,
  issueApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiTokenMetadata,
} from '../src/api-tokens.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

const createdAt = '2026-08-28T12:00:00.000Z'
const usedAt = '2026-08-28T12:01:00.000Z'
const revokedAt = '2026-08-28T12:02:00.000Z'

interface Harness {
  database: Parameters<typeof issueApiToken>[0]
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const client = new BetterSqlite3(':memory:')
  migrateContainer(client)
  return {
    database: createContainerDatabase(client),
    run: async (sql, ...params) => {
      client.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => client.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(client),
    close: async () => {
      client.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const client = await miniflare.getD1Database('DB')
  await migrateD1(client)
  return {
    database: createD1Database(client),
    run: async (sql, ...params) => {
      await client
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await client
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    migrateAgain: async () => migrateD1(client),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories) {
  describe(`API tokens (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory()
      await harness.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at)
          VALUES (?, '{}', ?, ?)`,
        'Halcyon Studio',
        createdAt,
        createdAt,
      )
      await harness.run(
        `INSERT INTO users (
          id, first_name, last_name, profile, manager_grants, is_owner,
          created_at, updated_at
        ) VALUES (1, 'Owner', 'Example', 'administrator', '[]', 0, ?, ?)`,
        createdAt,
        createdAt,
      )
    })

    beforeEach(async () => {
      await harness.run(
        `INSERT INTO users (
          id, first_name, last_name, profile, manager_grants, is_owner,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, '[]', 0, ?, ?)`,
        7,
        'Avery',
        'Ng',
        'accounting',
        createdAt,
        createdAt,
      )
    })

    afterEach(async () => {
      await harness.run(`DELETE FROM users WHERE id = 7`)
    })

    afterAll(async () => harness.close())

    const setup = async (): Promise<Harness> => harness

    const issue = async (db: Harness) =>
      issueApiToken(db.database, {
        userId: 7,
        name: 'MCP reports',
        scopes: ['reports:read', 'time_entries:read'],
        createdAt,
      })

    it('[security] persists only a digest and lists sorted scopes without the bearer secret', async () => {
      const db = await setup()
      const issued = await issueApiToken(db.database, {
        userId: 7,
        name: '  MCP reports  ',
        scopes: ['reports:read', 'time_entries:read'],
        createdAt,
      })
      expect(issued.token).toMatch(/^ezacto_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)
      expect(issued.scopes).toEqual(['reports:read', 'time_entries:read'])

      const [stored] = await db.rows<{
        selector: string
        secret_hash: string
        scopes: string
      }>(`SELECT selector, secret_hash, scopes FROM api_tokens WHERE id = ?`, issued.id)
      expect(stored).toBeDefined()
      expect(stored!.secret_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(stored!.secret_hash).not.toBe(issued.token)
      expect(stored!.secret_hash).not.toBe(issued.token.slice('ezacto_'.length + 17))
      expect(JSON.parse(stored!.scopes)).toEqual(['reports:read', 'time_entries:read'])

      expect(await listApiTokens(db.database, 7)).toEqual([
        {
          id: issued.id,
          name: 'MCP reports',
          scopes: ['reports:read', 'time_entries:read'],
          tokenHint: `ezacto_${stored!.selector}_…`,
          createdAt,
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        },
      ])

      await expect(
        db.run(
          `INSERT INTO api_tokens (
            user_id, selector, secret_hash, name, scopes, created_at, updated_at
          ) VALUES (7, 'cccccccccccccccc', ?, ' Raw ', '["reports:read"]', ?, ?)`,
          '0'.repeat(64),
          createdAt,
          createdAt,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO api_tokens (
            user_id, selector, secret_hash, name, scopes, created_at, updated_at
          ) VALUES (7, 'dddddddddddddddd', ?, ?, '["reports:read"]', ?, ?)`,
          '0'.repeat(64),
          '\t\n\u00a0',
          createdAt,
          createdAt,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
    })

    it('[api] measures token names in Unicode code points at native and physical boundaries', async () => {
      const db = await setup()
      const acceptedName = '🙂'.repeat(60)
      const issued = await issueApiToken(db.database, {
        userId: 7,
        name: acceptedName,
        scopes: ['reports:read'],
        createdAt,
      })
      expect(issued.name).toBe(acceptedName)

      await expect(
        issueApiToken(db.database, {
          userId: 7,
          name: '🙂'.repeat(101),
          scopes: ['reports:read'],
          createdAt,
        }),
      ).rejects.toThrow(/between 1 and 100 characters/)
      await expect(
        db.run(
          `INSERT INTO api_tokens (
            user_id, selector, secret_hash, name, scopes, created_at, updated_at
          ) VALUES (7, 'eeeeeeeeeeeeeeee', ?, ?, '["reports:read"]', ?, ?)`,
          '0'.repeat(64),
          '🙂'.repeat(101),
          createdAt,
          createdAt,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
    })

    it('[api] records last use and rejects a revoked token on the very next request', async () => {
      const db = await setup()
      const issued = await issue(db)
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toEqual({
        tokenId: issued.id,
        userId: 7,
        profile: 'accounting',
        managerGrants: [],
        scopes: ['reports:read', 'time_entries:read'],
      })
      expect((await listApiTokens(db.database, 7))[0]?.lastUsedAt).toBe(usedAt)

      const revoked = await revokeApiToken(db.database, {
        userId: 7,
        tokenId: issued.id,
        revokedAt,
      })
      expect(revoked?.revokedAt).toBe(revokedAt)
      expect(await authenticateApiToken(db.database, issued.token, revokedAt)).toBeNull()
    })

    it('[security] resolves current manager grants at authentication time', async () => {
      const db = await setup()
      const issued = await issue(db)
      await db.run(
        `UPDATE users SET manager_grants = ?, updated_at = ? WHERE id = 7`,
        '["billable_rates_manager"]',
        usedAt,
      )
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toMatchObject({
        managerGrants: ['billable_rates_manager'],
      })
      await db.run(`UPDATE users SET manager_grants = '[1]' WHERE id = 7`)
      expect(await authenticateApiToken(db.database, issued.token, revokedAt)).toBeNull()
    })

    it('[security] rejects altered, expired, and inactive-user tokens', async () => {
      const db = await setup()
      const issued = await issueApiToken(db.database, {
        userId: 7,
        name: 'Short lived',
        scopes: ['time_entries:read'],
        createdAt,
        expiresAt: usedAt,
      })
      const altered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`
      expect(await authenticateApiToken(db.database, altered, createdAt)).toBeNull()
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toBeNull()

      const active = await issue(db)
      await db.run(`UPDATE users SET is_active = 0, updated_at = ? WHERE id = 7`, usedAt)
      expect(await authenticateApiToken(db.database, active.token, usedAt)).toBeNull()
    })

    it('[security] compares timestamp variants chronologically and never regresses last use', async () => {
      const db = await setup()
      const secondCreated = '2026-08-28T13:00:00Z'
      const expiresAt = '2026-08-28T13:00:00.1Z'
      const issued = await issueApiToken(db.database, {
        userId: 7,
        name: 'Fractional expiry',
        scopes: ['reports:read'],
        createdAt: secondCreated,
        expiresAt,
      })
      const firstUse = '2026-08-28T13:00:00.09Z'
      const skewedUse = '2026-08-28T13:00:00.01Z'
      expect(await authenticateApiToken(db.database, issued.token, firstUse)).not.toBeNull()
      expect(await authenticateApiToken(db.database, issued.token, skewedUse)).not.toBeNull()
      expect((await listApiTokens(db.database, 7))[0]?.lastUsedAt).toBe(firstUse)
      expect(await authenticateApiToken(db.database, issued.token, expiresAt)).toBeNull()
    })

    it('[security] makes identity immutable and fails closed on malformed stored scopes', async () => {
      const db = await setup()
      const issued = await issue(db)
      await expect(
        db.run(`UPDATE api_tokens SET selector = 'aaaaaaaaaaaaaaaa' WHERE id = ?`, issued.id),
      ).rejects.toThrow(/identity and scopes are immutable/)
      await expect(
        db.run(`UPDATE api_tokens SET secret_hash = ? WHERE id = ?`, '0'.repeat(64), issued.id),
      ).rejects.toThrow(/identity and scopes are immutable/)
      await expect(
        db.run(`UPDATE api_tokens SET scopes = '["reports:read",7]' WHERE id = ?`, issued.id),
      ).rejects.toThrow(/identity and scopes are immutable/)

      await expect(
        db.run(
          `INSERT INTO api_tokens (
            user_id, selector, secret_hash, name, scopes, created_at, updated_at
          ) VALUES (7, 'bbbbbbbbbbbbbbbb', ?, 'Raw', '["unknown:read"]', ?, ?)`,
          '0'.repeat(64),
          createdAt,
          createdAt,
        ),
      ).rejects.toThrow(/canonical sorted unique strings/)
    })

    it('[security] revokes immediately even when the revoker clock trails last use', async () => {
      const db = await setup()
      const issued = await issue(db)
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).not.toBeNull()
      const revoked = await revokeApiToken(db.database, {
        userId: 7,
        tokenId: issued.id,
        revokedAt: createdAt,
      })
      expect(revoked?.revokedAt).toBe(usedAt)
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toBeNull()
      await expect(
        db.run(`UPDATE api_tokens SET revoked_at = NULL WHERE id = ?`, issued.id),
      ).rejects.toThrow(/revocation is irreversible/)
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toBeNull()
    })

    it('[security] cannot reactivate a revoked identity through INSERT OR REPLACE', async () => {
      const db = await setup()
      const issued = await issue(db)
      await revokeApiToken(db.database, {
        userId: 7,
        tokenId: issued.id,
        revokedAt,
      })

      const replaceAttempts = [
        `INSERT OR REPLACE INTO api_tokens (
          id, user_id, selector, secret_hash, name, scopes, last_used_at,
          expires_at, revoked_at, created_at, updated_at
        ) SELECT id, user_id, selector, secret_hash, name, scopes, last_used_at,
          expires_at, NULL, created_at, updated_at
        FROM api_tokens WHERE id = ?`,
        `INSERT OR REPLACE INTO api_tokens (
          id, user_id, selector, secret_hash, name, scopes, last_used_at,
          expires_at, revoked_at, created_at, updated_at
        ) SELECT id + 1000, user_id, selector, secret_hash, name, scopes, last_used_at,
          expires_at, NULL, created_at, updated_at
        FROM api_tokens WHERE id = ?`,
        `INSERT OR REPLACE INTO api_tokens (
          id, user_id, selector, secret_hash, name, scopes, last_used_at,
          expires_at, revoked_at, created_at, updated_at
        ) SELECT id, user_id, 'replacementselector', secret_hash, name, scopes, last_used_at,
          expires_at, NULL, created_at, updated_at
        FROM api_tokens WHERE id = ?`,
      ]
      for (const statement of replaceAttempts) {
        await expect(db.run(statement, issued.id)).rejects.toThrow(/identity cannot be replaced/)
        expect(await authenticateApiToken(db.database, issued.token, revokedAt)).toBeNull()
      }
    })

    it('[security] keeps token ids immutable before UPDATE OR REPLACE conflict handling', async () => {
      const db = await setup()
      const revoked = await issueApiToken(db.database, {
        userId: 7,
        name: 'Revoked identity',
        scopes: ['reports:read'],
        createdAt,
      })
      await revokeApiToken(db.database, {
        userId: 7,
        tokenId: revoked.id,
        revokedAt,
      })
      const active = await issueApiToken(db.database, {
        userId: 7,
        name: 'Active identity',
        scopes: ['reports:read'],
        createdAt,
      })

      await expect(
        db.run(`UPDATE api_tokens SET id = id + 1000 WHERE id = ?`, active.id),
      ).rejects.toThrow(/identity and scopes are immutable/)
      await expect(
        db.run(`UPDATE OR REPLACE api_tokens SET id = ? WHERE id = ?`, revoked.id, active.id),
      ).rejects.toThrow(/identity and scopes are immutable/)

      expect(
        await db.rows<{ id: number; name: string; revoked_at: string | null }>(
          `SELECT id, name, revoked_at FROM api_tokens WHERE user_id = 7 ORDER BY id`,
        ),
      ).toEqual([
        { id: revoked.id, name: 'Revoked identity', revoked_at: revokedAt },
        { id: active.id, name: 'Active identity', revoked_at: null },
      ])
      expect(await authenticateApiToken(db.database, revoked.token, revokedAt)).toBeNull()
      expect(await authenticateApiToken(db.database, active.token, revokedAt)).toMatchObject({
        tokenId: active.id,
      })
    })

    it('[security] cannot extend or clear an expired token lifetime through raw SQL', async () => {
      const db = await setup()
      const expiresAt = '2026-08-28T12:00:00.500Z'
      const expired = await issueApiToken(db.database, {
        userId: 7,
        name: 'Short lived',
        scopes: ['reports:read'],
        expiresAt,
        createdAt,
      })
      expect(await authenticateApiToken(db.database, expired.token, usedAt)).toBeNull()

      for (const replacement of [null, '2026-08-29T12:00:00.000Z']) {
        await expect(
          db.run(`UPDATE api_tokens SET expires_at = ? WHERE id = ?`, replacement, expired.id),
        ).rejects.toThrow(/identity and scopes are immutable/)
        expect(await authenticateApiToken(db.database, expired.token, usedAt)).toBeNull()
      }
      expect((await listApiTokens(db.database, 7))[0]?.expiresAt).toBe(expiresAt)
    })

    it('[security] clamps a clock-skewed first use to token creation time', async () => {
      const db = await setup()
      const issued = await issue(db)
      const skewedUse = '2026-08-28T11:59:59.900Z'
      expect(await authenticateApiToken(db.database, issued.token, skewedUse)).not.toBeNull()
      expect((await listApiTokens(db.database, 7))[0]?.lastUsedAt).toBe(createdAt)
    })

    it('[security] rechecks the current active profile at the authentication write boundary', async () => {
      const db = await setup()
      const issued = await issueApiToken(db.database, {
        userId: 7,
        name: 'Invoices',
        scopes: ['invoices:write'],
        createdAt,
      })
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toMatchObject({
        profile: 'accounting',
      })

      await db.run(`UPDATE users SET profile = 'member', updated_at = ? WHERE id = 7`, usedAt)
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toBeNull()
      await db.run(`UPDATE users SET profile = 'accounting', updated_at = ? WHERE id = 7`, usedAt)
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toMatchObject({
        profile: 'accounting',
      })
      await db.run(`UPDATE users SET is_active = 0, updated_at = ? WHERE id = 7`, usedAt)
      expect(await authenticateApiToken(db.database, issued.token, usedAt)).toBeNull()
    })

    it('[unit] keeps token ownership isolated and the reserved migration idempotent', async () => {
      const db = await setup()
      const issued = await issue(db)
      expect(
        await revokeApiToken(db.database, { userId: 8, tokenId: issued.id, revokedAt }),
      ).toBeNull()
      expect((await listApiTokens(db.database, 7))[0]?.revokedAt).toBeNull()

      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE id = '0011_api_tokens'`,
        ),
      ).toEqual([{ id: '0011_api_tokens' }])
    })

    it('[unit] validates scope and expiry boundaries before persistence', async () => {
      const db = await setup()
      await expect(
        issueApiToken(db.database, {
          userId: 7,
          name: 'Duplicate',
          scopes: ['time_entries:read', 'time_entries:read'],
          createdAt,
        }),
      ).rejects.toThrow(/duplicates/)
      await expect(
        issueApiToken(db.database, {
          userId: 7,
          name: 'Expired',
          scopes: ['time_entries:read'],
          createdAt,
          expiresAt: createdAt,
        }),
      ).rejects.toThrow(/after createdAt/)
      await expect(
        issueApiToken(db.database, {
          userId: 7,
          name: 'Unknown scope',
          scopes: ['root:everything'],
          createdAt,
        }),
      ).rejects.toThrow(/invalid API token scope/)
      await db.run(`UPDATE users SET profile = 'member', updated_at = ? WHERE id = 7`, usedAt)
      await expect(
        issueApiToken(db.database, {
          userId: 7,
          name: 'Privilege escalation',
          scopes: ['invoices:write'],
          createdAt,
        }),
      ).rejects.toThrow(/active user profile cannot grant/)
      expect(await listApiTokens(db.database, 7)).toEqual([] as ApiTokenMetadata[])
    })
  })
}
