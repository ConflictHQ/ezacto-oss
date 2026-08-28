import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderIdentityAssertion } from '@ezacto/core'
import {
  createContainerIdentityStore,
  createD1IdentityStore,
  type IdentityStore,
} from '../src/identity.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

const timestamp = '2026-08-28T20:00:00.000Z'

interface Harness {
  store: IdentityStore
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    store: createContainerIdentityStore(database, { now: () => timestamp }),
    run: async (sql, ...bindings) => {
      database.prepare(sql).run(...bindings)
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      database.prepare(sql).all(...bindings) as T[],
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
  return {
    store: createD1IdentityStore(database, { now: () => timestamp }),
    run: async (sql, ...bindings) => {
      await database
        .prepare(sql)
        .bind(...bindings)
        .run()
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(sql)
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

const assertion = (
  changes: Partial<ProviderIdentityAssertion> = {},
): ProviderIdentityAssertion => ({
  provider: 'google',
  subject: 'google-subject-1',
  email: 'person@example.test',
  emailVerified: true,
  firstName: 'Avery',
  lastName: 'Ng',
  ...changes,
})

for (const [runtime, factory] of factories) {
  describe(`identity store (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory()
      await harness.run(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
          VALUES (1, 'Halcyon Studio', '{}', ?, ?)`,
        timestamp,
        timestamp,
      )
      await harness.run(
        `INSERT INTO users (
          id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at
        ) VALUES (1, 'Owner', 'Example', 'administrator', '[]', 0, ?, ?)`,
        timestamp,
        timestamp,
      )
      await harness.run(
        `INSERT INTO user_emails (
          id, user_id, address, verified_at, is_primary, created_at, updated_at
        ) VALUES (1, 1, 'owner@example.test', ?, 1, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
    })

    beforeEach(async () => {
      await harness.run(`DELETE FROM user_identities`)
      await harness.run(`DELETE FROM user_emails WHERE user_id <> 1`)
      await harness.run(`DELETE FROM users WHERE id <> 1`)
    })

    afterAll(async () => harness.close())

    const insertUser = async (id: number, active = true): Promise<void> => {
      await harness.run(
        `INSERT INTO users (
          id, first_name, last_name, profile, manager_grants, is_active, is_owner,
          created_at, updated_at
        ) VALUES (?, 'Existing', 'Person', 'accounting', '["clients:all"]', ?, 0, ?, ?)`,
        id,
        active ? 1 : 0,
        timestamp,
        timestamp,
      )
    }

    const insertEmail = async (
      id: number,
      userId: number,
      address: string,
      verified: boolean,
      primary = false,
    ): Promise<void> => {
      await harness.run(
        `INSERT INTO user_emails (
          id, user_id, address, verified_at, is_primary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        address,
        verified ? timestamp : null,
        primary ? 1 : 0,
        timestamp,
        timestamp,
      )
    }

    const resolutionCases = [
      {
        name: 'stable provider subject wins over a changed verified email',
        arrange: async () => {
          await insertUser(2)
          await insertEmail(2, 2, 'old-address@example.test', true, true)
          await harness.run(
            `INSERT INTO user_identities (
              id, user_id, provider, provider_subject, created_at, updated_at
            ) VALUES (2, 2, 'google', 'stable-subject', ?, ?)`,
            timestamp,
            timestamp,
          )
          await insertUser(3)
          await insertEmail(3, 3, 'new-address@example.test', true, true)
          return assertion({
            subject: 'stable-subject',
            email: 'new-address@example.test',
          })
        },
        expected: { userId: 2, matchedBy: 'subject' },
      },
      {
        name: 'verified email links a previously unseen provider subject',
        arrange: async () => {
          await insertUser(2)
          await insertEmail(2, 2, 'linked@example.test', true, true)
          return assertion({ subject: 'new-subject', email: 'LINKED@example.test' })
        },
        expected: { userId: 2, matchedBy: 'verified_email' },
      },
      {
        name: 'no subject or verified-email match creates a member',
        arrange: async () => assertion({ subject: 'new-subject', email: 'new@example.test' }),
        expected: { userId: 2, matchedBy: 'created' },
      },
      {
        name: 'a squatted pending address cannot block its verified owner',
        arrange: async () => {
          await insertUser(2)
          await insertEmail(2, 2, 'squatted@example.test', false)
          return assertion({ subject: 'owner-subject', email: 'SQUATTED@example.test' })
        },
        expected: { userId: 3, matchedBy: 'created' },
      },
    ] as const

    it.each(resolutionCases)('[unit] resolution order: $name', async ({ arrange, expected }) => {
      const input = await arrange()
      const result = await harness.store.resolveProvider(input)
      expect(result).toMatchObject({
        status: 'active',
        profile: expected.matchedBy === 'created' ? 'member' : 'accounting',
        managerGrants: expected.matchedBy === 'created' ? [] : ['clients:all'],
        ...expected,
      })
      expect(
        await harness.rows<{ user_id: number }>(
          `SELECT user_id FROM user_identities
           WHERE provider = ? AND provider_subject = ?`,
          'google',
          input.subject,
        ),
      ).toEqual([{ user_id: expected.userId }])
    })

    it('[unit] invalidates a squatted pending row when the verified owner is created', async () => {
      await insertUser(2)
      await insertEmail(2, 2, 'victim@example.test', false)
      const result = await harness.store.resolveProvider(
        assertion({ subject: 'verified-owner', email: 'VICTIM@example.test' }),
      )
      expect(result).toMatchObject({ userId: 3, matchedBy: 'created' })
      expect(
        await harness.rows<{
          user_id: number
          verified_at: string | null
          invalidated_at: string | null
        }>(
          `SELECT user_id, verified_at, invalidated_at
           FROM user_emails WHERE lower(address) = 'victim@example.test'
           ORDER BY user_id`,
        ),
      ).toEqual([
        { user_id: 2, verified_at: null, invalidated_at: timestamp },
        { user_id: 3, verified_at: timestamp, invalidated_at: null },
      ])
    })

    it('[security] never links an unverified provider email to an existing user', async () => {
      await insertUser(2)
      await insertEmail(2, 2, 'shared@example.test', true, true)
      const result = await harness.store.resolveProvider(
        assertion({
          subject: 'unverified-subject',
          email: 'shared@example.test',
          emailVerified: false,
        }),
      )
      expect(result).toMatchObject({ userId: 3, matchedBy: 'created' })
      expect(
        await harness.rows<{ user_id: number; verified_at: string | null }>(
          `SELECT user_id, verified_at FROM user_emails
           WHERE lower(address) = 'shared@example.test' ORDER BY user_id`,
        ),
      ).toEqual([
        { user_id: 2, verified_at: timestamp },
        { user_id: 3, verified_at: null },
      ])
    })

    it('[unit] keeps a provider subject attached after its asserted email changes', async () => {
      const first = await harness.store.resolveProvider(
        assertion({ subject: 'stable-google-sub', email: 'before@example.test' }),
      )
      const second = await harness.store.resolveProvider(
        assertion({ subject: 'stable-google-sub', email: 'after@example.test' }),
      )
      expect(first).toMatchObject({ userId: 2, matchedBy: 'created' })
      expect(second).toMatchObject({ userId: 2, matchedBy: 'subject' })
      expect(
        await harness.rows<{ address: string }>(
          `SELECT address FROM user_emails WHERE user_id = 2 ORDER BY id`,
        ),
      ).toEqual([{ address: 'before@example.test' }])
    })

    it('[api] signs in with any verified address and sends every other address to verification', async () => {
      await insertUser(2)
      await insertEmail(2, 2, 'primary@example.test', true, true)
      await insertEmail(3, 2, 'SECONDARY@example.test', true)
      await insertEmail(4, 2, 'pending@example.test', false)

      for (const address of ['primary@example.test', 'secondary@example.test']) {
        await expect(harness.store.resolveEmail(address)).resolves.toEqual({
          status: 'active',
          userId: 2,
          profile: 'accounting',
          managerGrants: ['clients:all'],
        })
      }
      await expect(harness.store.resolveEmail('pending@example.test')).resolves.toEqual({
        status: 'verification_required',
      })
      await expect(harness.store.resolveEmail('unknown@example.test')).resolves.toEqual({
        status: 'verification_required',
      })
    })

    it('[security] does not expose a disabled user through email sign-in', async () => {
      await insertUser(2, false)
      await insertEmail(2, 2, 'disabled@example.test', true, true)
      await expect(harness.store.resolveEmail('disabled@example.test')).resolves.toEqual({
        status: 'verification_required',
      })
    })
  })
}
