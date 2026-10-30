import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderIdentityAssertion } from '@ezacto/core'
import {
  createContainerIdentityStore,
  createD1IdentityStore,
  selfSignupProjectIdFromVariable,
  type IdentityStore,
  type IdentityStoreOptions,
} from '../src/identity.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

const timestamp = '2026-08-28T20:00:00.000Z'

interface Harness {
  store: IdentityStore
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

type HarnessOptions = Pick<IdentityStoreOptions, 'selfSignup'>

const containerHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    store: createContainerIdentityStore(database, { now: () => timestamp, ...options }),
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

const d1Harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    store: createD1IdentityStore(database, { now: () => timestamp, ...options }),
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

    // Provisioning is scoped to domains the instance has proved it owns, so
    // every case that expects a user to be created needs one. `example.test` is
    // this instance's work domain; `unproven.test` is claimed but never
    // verified, and stands for the settings row an operator filled in and has
    // not published the TXT record for.
    beforeEach(async () => {
      await harness.run(`DELETE FROM user_identities`)
      await harness.run(`DELETE FROM user_emails WHERE user_id <> 1`)
      await harness.run(`DELETE FROM users WHERE id <> 1`)
      await harness.run(`DELETE FROM sso_provisioning_domains`)
      await harness.run(
        `INSERT INTO sso_provisioning_domains (
          id, domain, challenge_token, verified_at, last_checked_at, created_at, updated_at
        ) VALUES (1, 'example.test', ?, ?, ?, ?, ?)`,
        'A'.repeat(43),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await harness.run(
        `INSERT INTO sso_provisioning_domains (
          id, domain, challenge_token, verified_at, last_checked_at, created_at, updated_at
        ) VALUES (2, 'unproven.test', ?, NULL, NULL, ?, ?)`,
        'B'.repeat(43),
        timestamp,
        timestamp,
      )
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

    /**
     * #736. This used to assert that an unverified claim was merely not
     * *linked*: it still provisioned a fresh user holding the address
     * unverified. That is the squat -- an address is unique while it lives, so
     * the real owner could never add it afterwards. A verified provisioning
     * domain says the domain is ours, not that this claimant is who they say,
     * and provisioning now refuses exactly as linking already did.
     */
    it('[security] never links or provisions from an unverified provider email', async () => {
      await insertUser(2)
      await insertEmail(2, 2, 'shared@example.test', true, true)
      const result = await harness.store.resolveProvider(
        assertion({
          subject: 'unverified-subject',
          email: 'shared@example.test',
          emailVerified: false,
        }),
      )
      expect(result).toEqual({ status: 'provisioning_not_permitted' })
      // The existing owner's row is untouched, and no squatting row appears.
      expect(
        await harness.rows<{ user_id: number; verified_at: string | null }>(
          `SELECT user_id, verified_at FROM user_emails
           WHERE lower(address) = 'shared@example.test' ORDER BY user_id`,
        ),
      ).toEqual([{ user_id: 2, verified_at: timestamp }])
    })

    it('[security] provisions nobody from an unverified claim at an unknown address', async () => {
      const result = await harness.store.resolveProvider(
        assertion({
          subject: 'fresh-subject',
          email: 'nobody@example.test',
          emailVerified: false,
        }),
      )
      expect(result).toEqual({ status: 'provisioning_not_permitted' })
      expect(
        await harness.rows<{ id: number }>(
          `SELECT id FROM user_emails WHERE lower(address) = 'nobody@example.test'`,
        ),
      ).toEqual([])
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

    it('[unit] does not require mutable profile claims for a known subject or verified email', async () => {
      await insertUser(2)
      await insertEmail(2, 2, 'linked-no-profile@example.test', true, true)
      await expect(
        harness.store.resolveProvider({
          provider: 'google',
          subject: 'linked-no-profile',
          email: 'linked-no-profile@example.test',
          emailVerified: true,
        }),
      ).resolves.toMatchObject({ userId: 2, matchedBy: 'verified_email' })

      await expect(
        harness.store.resolveProvider({
          provider: 'google',
          subject: 'linked-no-profile',
          email: 'changed@example.test',
          emailVerified: true,
        }),
      ).resolves.toMatchObject({ userId: 2, matchedBy: 'subject' })
    })

    it('[unit] requires profile claims only when provider resolution creates a user', async () => {
      await expect(
        harness.store.resolveProvider({
          provider: 'google',
          subject: 'new-no-profile',
          email: 'new-no-profile@example.test',
          emailVerified: true,
        }),
      ).rejects.toThrow(/firstName and lastName are required/)
      expect(await harness.rows(`SELECT id FROM users WHERE id <> 1`)).toEqual([])
      expect(await harness.rows(`SELECT id FROM user_identities`)).toEqual([])
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

    const refusalCases = [
      {
        name: 'a domain that was claimed in settings but never proved',
        assertion: () => assertion({ subject: 'claimant', email: 'new@unproven.test' }),
      },
      {
        name: 'a domain nobody configured at all',
        assertion: () => assertion({ subject: 'stranger', email: 'stranger@gmail.test' }),
      },
      {
        name: 'a proven work address overridden by an unproven hosted domain',
        assertion: () =>
          assertion({
            subject: 'wrong-tenant',
            email: 'someone@example.test',
            hostedDomain: 'unproven.test',
          }),
      },
    ] as const

    it.each(refusalCases)(
      '[security] refuses to provision from $name',
      async ({ assertion: build }) => {
        const input = build()
        await expect(harness.store.resolveProvider(input)).resolves.toEqual({
          status: 'provisioning_not_permitted',
        })
        expect(await harness.rows(`SELECT id FROM users WHERE id <> 1`)).toEqual([])
        expect(await harness.rows(`SELECT id FROM user_identities`)).toEqual([])
        expect(await harness.rows(`SELECT id FROM user_emails WHERE user_id <> 1`)).toEqual([])
      },
    )

    it('[security] stops provisioning the moment a domain loses its verification', async () => {
      await harness.run(
        `UPDATE sso_provisioning_domains SET verified_at = NULL WHERE domain = 'example.test'`,
      )
      await expect(
        harness.store.resolveProvider(assertion({ subject: 'lapsed', email: 'new@example.test' })),
      ).resolves.toEqual({ status: 'provisioning_not_permitted' })
      expect(await harness.rows(`SELECT id FROM users WHERE id <> 1`)).toEqual([])
    })

    it('[security] links a personal address at an unscoped domain without provisioning one', async () => {
      await insertUser(2)
      await insertEmail(2, 2, 'person@gmail.test', true, true)
      await expect(
        harness.store.resolveProvider(
          assertion({ subject: 'personal-subject', email: 'person@gmail.test' }),
        ),
      ).resolves.toMatchObject({ userId: 2, matchedBy: 'verified_email' })
      expect(await harness.rows(`SELECT id FROM users WHERE id <> 1`)).toEqual([{ id: 2 }])
    })

    it('[unit] provisions on the hosted domain the provider asserts, not the address domain', async () => {
      await expect(
        harness.store.resolveProvider(
          assertion({
            subject: 'alias-subject',
            email: 'person@alias.test',
            hostedDomain: 'example.test',
          }),
        ),
      ).resolves.toMatchObject({ userId: 2, matchedBy: 'created' })
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

describe('selfSignupProjectIdFromVariable', () => {
  it('[unit] treats unset and blank as off', () => {
    expect(selfSignupProjectIdFromVariable(undefined)).toBeNull()
    expect(selfSignupProjectIdFromVariable('  ')).toBeNull()
  })

  it('[unit] reads a project id', () => {
    expect(selfSignupProjectIdFromVariable(' 12 ')).toBe(12)
  })

  it.each(['0', '-1', '1.5', 'twelve', '12abc', '99999999999999999'])(
    '[security] refuses %s rather than guessing a project',
    (value) => {
      expect(() => selfSignupProjectIdFromVariable(value)).toThrow(TypeError)
    },
  )
})

// The App Review instance: whoever signs in with Apple joins as a member of
// one project. Nothing about it may reach other providers, unverified
// addresses, or a project an administrator has archived.
const signupProjectId = 7

for (const [runtime, factory] of factories) {
  describe(`identity store self sign-up (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory({ selfSignup: { provider: 'apple', projectId: signupProjectId } })
      await harness.run(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
          VALUES (1, 'eZacto Review', '{}', ?, ?)`,
        timestamp,
        timestamp,
      )
      await harness.run(
        `INSERT INTO users (
          id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at
        ) VALUES (1, 'App', 'Reviewer', 'administrator', '[]', 0, ?, ?)`,
        timestamp,
        timestamp,
      )
      await harness.run(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
          VALUES (1, 'Review Client', 'USD', ?, ?)`,
        timestamp,
        timestamp,
      )
      await harness.run(
        `INSERT INTO projects (id, client_id, name, created_at, updated_at)
          VALUES (?, 1, 'Default', ?, ?)`,
        signupProjectId,
        timestamp,
        timestamp,
      )
    })

    beforeEach(async () => {
      await harness.run(`DELETE FROM user_assignments`)
      await harness.run(`DELETE FROM user_identities`)
      await harness.run(`DELETE FROM user_emails`)
      await harness.run(`DELETE FROM users WHERE id <> 1`)
      await harness.run(`UPDATE projects SET is_active = 1 WHERE id = ?`, signupProjectId)
    })

    afterAll(async () => harness.close())

    // Apple sends the name on the first authorization only.
    const appleWithoutName = (): ProviderIdentityAssertion => ({
      provider: 'apple',
      subject: '001234.reviewer',
      email: 'x7k2q9@privaterelay.appleid.com',
      emailVerified: true,
    })

    const apple = (changes: Partial<ProviderIdentityAssertion> = {}): ProviderIdentityAssertion => ({
      ...appleWithoutName(),
      firstName: 'Jamie',
      lastName: 'Reviewer',
      ...changes,
    })

    const nothingCreated = async (): Promise<void> => {
      expect(await harness.rows(`SELECT id FROM users WHERE id <> 1`)).toEqual([])
      expect(await harness.rows(`SELECT id FROM user_identities`)).toEqual([])
      expect(await harness.rows(`SELECT id FROM user_emails`)).toEqual([])
      expect(await harness.rows(`SELECT id FROM user_assignments`)).toEqual([])
    }

    it('[unit] signs up an unknown Apple ID as a member of the one project', async () => {
      await expect(harness.store.resolveProvider(apple())).resolves.toEqual({
        status: 'active',
        matchedBy: 'created',
        userId: 2,
        profile: 'member',
        managerGrants: [],
      })
      expect(
        await harness.rows(`SELECT first_name, last_name, profile, is_owner FROM users WHERE id = 2`),
      ).toEqual([{ first_name: 'Jamie', last_name: 'Reviewer', profile: 'member', is_owner: 0 }])
      expect(
        await harness.rows(
          `SELECT address, verified_at IS NOT NULL AS verified FROM user_emails WHERE user_id = 2`,
        ),
      ).toEqual([{ address: 'x7k2q9@privaterelay.appleid.com', verified: 1 }])
      expect(
        await harness.rows(
          `SELECT project_id, user_id, is_active, is_project_manager, use_default_rates
            FROM user_assignments`,
        ),
      ).toEqual([
        {
          project_id: signupProjectId,
          user_id: 2,
          is_active: 1,
          is_project_manager: 0,
          use_default_rates: 1,
        },
      ])
    })

    it('[unit] names the account when Apple withholds the name on a later authorization', async () => {
      await expect(
        harness.store.resolveProvider(appleWithoutName()),
      ).resolves.toMatchObject({ userId: 2, matchedBy: 'created' })
      expect(await harness.rows(`SELECT first_name, last_name FROM users WHERE id = 2`)).toEqual([
        { first_name: 'New', last_name: 'Member' },
      ])
    })

    it('[unit] signs the same Apple ID back in without a second account or assignment', async () => {
      await harness.store.resolveProvider(apple())
      await expect(
        harness.store.resolveProvider(appleWithoutName()),
      ).resolves.toMatchObject({ userId: 2, matchedBy: 'subject' })
      expect(await harness.rows(`SELECT id FROM users WHERE id <> 1`)).toEqual([{ id: 2 }])
      expect(await harness.rows(`SELECT user_id FROM user_assignments`)).toEqual([{ user_id: 2 }])
    })

    it('[security] refuses an Apple address the provider has not verified', async () => {
      await expect(harness.store.resolveProvider(apple({ emailVerified: false }))).resolves.toEqual({
        status: 'provisioning_not_permitted',
      })
      await nothingCreated()
    })

    it('[security] keeps every other provider scoped to verified domains', async () => {
      await expect(
        harness.store.resolveProvider(
          apple({ provider: 'google', subject: 'google-stranger', email: 'stranger@gmail.test' }),
        ),
      ).resolves.toEqual({ status: 'provisioning_not_permitted' })
      await nothingCreated()
    })

    it('[security] closes sign-up once the project is archived', async () => {
      await harness.run(`UPDATE projects SET is_active = 0 WHERE id = ?`, signupProjectId)
      await expect(harness.store.resolveProvider(apple())).resolves.toEqual({
        status: 'provisioning_not_permitted',
      })
      await nothingCreated()
    })
  })
}

describe('identity store self sign-up to a missing project', () => {
  it.each(factories)('[security] refuses on %s rather than creating an unassigned member', async (_, factory) => {
    const harness = await factory({ selfSignup: { provider: 'apple', projectId: 404 } })
    try {
      await expect(
        harness.store.resolveProvider({
          provider: 'apple',
          subject: '001234.reviewer',
          email: 'reviewer@icloud.com',
          emailVerified: true,
        }),
      ).resolves.toEqual({ status: 'provisioning_not_permitted' })
      expect(await harness.rows(`SELECT id FROM users`)).toEqual([])
    } finally {
      await harness.close()
    }
  })
})
