import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { authenticateApiToken } from '../src/api-tokens.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  bootstrapInstanceContainer,
  bootstrapInstanceD1,
  enrollInstanceOwnerPasswordContainer,
  enrollInstanceOwnerPasswordD1,
  InstanceBootstrapConflictError,
  InstanceOwnerPasswordConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapOptions,
} from '../src/instance-bootstrap.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createContainerPasswordAuthService,
  createD1PasswordAuthService,
} from '../src/password-auth.js'

const timestamp = '2026-08-28T15:00:00.000Z'
const usedAt = '2026-08-28T15:01:00.000Z'
const token = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const input: InstanceBootstrapInput = {
  organizationName: 'Conflict',
  ownerFirstName: 'Luis',
  ownerLastName: 'Herrera',
  ownerEmail: 'luis@example.com',
  token,
}
const options: InstanceBootstrapOptions = { now: () => timestamp }
const ownerPassword = 'correct horse battery staple'

interface Harness {
  bootstrap(value?: InstanceBootstrapInput, createdAt?: string): Promise<void>
  enroll(password?: string, presentedToken?: string, createdAt?: string): Promise<void>
  authenticate(value: string): ReturnType<typeof authenticateApiToken>
  signIn(password?: string): Promise<unknown>
  run(statement: string, ...bindings: unknown[]): Promise<void>
  rows<T>(statement: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = (): Harness => {
  const client = new BetterSqlite3(':memory:')
  migrateContainer(client)
  const database = createContainerDatabase(client)
  return {
    bootstrap: async (value = input, createdAt = timestamp) => {
      await bootstrapInstanceContainer(client, value, { now: () => createdAt })
    },
    enroll: async (
      password = ownerPassword,
      presentedToken = token,
      createdAt = usedAt,
    ) => {
      await enrollInstanceOwnerPasswordContainer(
        client,
        { token: presentedToken, password },
        { now: () => createdAt },
      )
    },
    authenticate: (value) => authenticateApiToken(database, value, usedAt),
    signIn: (password = ownerPassword) =>
      createContainerPasswordAuthService(client, { now: () => usedAt }).signIn({
        email: input.ownerEmail,
        password,
        clientKey: 'instance-bootstrap-test',
      }),
    run: async (statement, ...bindings) => {
      client.prepare(statement).run(...bindings)
    },
    rows: async <T>(statement: string, ...bindings: unknown[]) =>
      client.prepare(statement).all(...bindings) as T[],
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
  const database = createD1Database(client)
  return {
    bootstrap: async (value = input, createdAt = timestamp) => {
      await bootstrapInstanceD1(client, value, { now: () => createdAt })
    },
    enroll: async (
      password = ownerPassword,
      presentedToken = token,
      createdAt = usedAt,
    ) => {
      await enrollInstanceOwnerPasswordD1(
        client,
        { token: presentedToken, password },
        { now: () => createdAt },
      )
    },
    authenticate: (value) => authenticateApiToken(database, value, usedAt),
    signIn: (password = ownerPassword) =>
      createD1PasswordAuthService(client, { now: () => usedAt }).signIn({
        email: input.ownerEmail,
        password,
        clientKey: 'instance-bootstrap-test',
      }),
    run: async (statement, ...bindings) => {
      await client
        .prepare(statement)
        .bind(...bindings)
        .run()
    },
    rows: async <T>(statement: string, ...bindings: unknown[]) =>
      (
        await client
          .prepare(statement)
          .bind(...bindings)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerHarness()],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories) {
  describe(`instance bootstrap (${runtime})`, () => {
    let harness: Harness | undefined

    afterEach(async () => {
      await harness?.close()
      harness = undefined
    })

    it('[security] atomically creates the owner credential and accepts only an exact re-run', async () => {
      harness = await factory()
      await harness.bootstrap()

      expect(await harness.authenticate(token)).toEqual({
        tokenId: 1,
        userId: 1,
        profile: 'administrator',
        managerGrants: [],
        scopes: [
          'clients:read',
          'clients:write',
          'expenses:read',
          'expenses:write',
          'invoices:read',
          'invoices:write',
          'projects:read',
          'projects:write',
          'reports:read',
          'schedule:read',
          'schedule:write',
          'team:read',
          'time_entries:read',
          'time_entries:write',
        ],
      })

      // Authentication updates token-use metadata; it must not make the exact
      // operator retry non-idempotent.
      await harness.bootstrap(input, '2026-08-28T15:02:00.000Z')
      expect(
        await harness.rows<{
          organizations: number
          users: number
          emails: number
          tokens: number
        }>(
          `SELECT
            (SELECT count(*) FROM organizations) AS organizations,
            (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM user_emails) AS emails,
            (SELECT count(*) FROM api_tokens) AS tokens`,
        ),
      ).toEqual([{ organizations: 1, users: 1, emails: 1, tokens: 1 }])
      expect(
        await harness.rows<Record<string, unknown>>(
          `SELECT user.id, user.profile, user.is_owner, email.address,
            email.is_primary, email.verified_at
          FROM users user JOIN user_emails email ON email.user_id = user.id`,
        ),
      ).toEqual([
        {
          id: 1,
          profile: 'administrator',
          is_owner: 1,
          address: 'luis@example.com',
          is_primary: 1,
          verified_at: timestamp,
        },
      ])

      const stored = await harness.rows<{
        selector: string
        secret_hash: string
        audit_hash: string
        last_used_at: string
      }>(
        `SELECT token.selector, token.secret_hash,
          bootstrap.token_secret_hash AS audit_hash, token.last_used_at
        FROM api_tokens token CROSS JOIN instance_bootstrap bootstrap`,
      )
      expect(stored[0]).toMatchObject({
        selector: 'abcdefghijklmnop',
        secret_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        audit_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        last_used_at: usedAt,
      })
      expect(stored[0]!.secret_hash).toBe(stored[0]!.audit_hash)
      expect(JSON.stringify(stored)).not.toContain(token)
      expect(JSON.stringify(stored)).not.toContain('A'.repeat(43))

      for (const mismatch of [
        { ...input, organizationName: 'Different Organization' },
        { ...input, ownerFirstName: 'Rosalind' },
        { ...input, ownerEmail: 'different@example.com' },
        { ...input, token: `ezacto_abcdefghijklmnop_${'B'.repeat(43)}` },
      ]) {
        await expect(harness.bootstrap(mismatch)).rejects.toBeInstanceOf(
          InstanceBootstrapConflictError,
        )
      }
    })

    it('[security] rejects unexpected identity state without adding bootstrap rows', async () => {
      harness = await factory()
      await harness.run(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
          VALUES (1, 'Unexpected', '{}', ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(harness.bootstrap()).rejects.toBeInstanceOf(InstanceBootstrapConflictError)
      expect(await harness.rows(`SELECT id FROM instance_bootstrap`)).toEqual([])
      expect(await harness.rows(`SELECT id FROM users`)).toEqual([])
      expect(await harness.rows(`SELECT id FROM api_tokens`)).toEqual([])
    })

    it('[security] rolls back the complete seed when any statement fails', async () => {
      harness = await factory()
      await harness.run(`CREATE TRIGGER test_reject_bootstrap_email
        BEFORE INSERT ON user_emails
        BEGIN SELECT RAISE(ABORT, 'test email failure'); END`)
      await expect(harness.bootstrap()).rejects.toThrow(/test email failure/i)
      for (const table of [
        'instance_bootstrap',
        'organizations',
        'users',
        'organization_owner',
        'user_emails',
        'api_tokens',
      ]) {
        expect(
          await harness.rows<{ count: number }>(`SELECT count(*) AS count FROM ${table}`),
        ).toEqual([{ count: 0 }])
      }
    })

    it('[security] enrolls only the exact bootstrapped owner password and makes browser sign-in usable', async () => {
      harness = await factory()
      await harness.bootstrap()
      expect(await harness.signIn()).toEqual({ status: 'invalid_credentials' })

      await harness.enroll()
      expect(await harness.signIn()).toEqual({
        status: 'authenticated',
        principal: {
          userId: 1,
          profile: 'administrator',
          managerGrants: [],
        },
      })

      await harness.enroll(ownerPassword, token, '2026-08-28T15:03:00.000Z')
      await expect(
        harness.enroll('a different valid password', token, '2026-08-28T15:04:00.000Z'),
      ).rejects.toBeInstanceOf(InstanceOwnerPasswordConflictError)
      await expect(
        harness.enroll(ownerPassword, `ezacto_abcdefghijklmnop_${'B'.repeat(43)}`),
      ).rejects.toBeInstanceOf(InstanceOwnerPasswordConflictError)
      expect(await harness.signIn('a different valid password')).toEqual({
        status: 'invalid_credentials',
      })
      expect(await harness.rows(`SELECT user_id FROM user_passwords`)).toEqual([
        { user_id: 1 },
      ])
    })

    it('[security] fails closed and leaves the bootstrap audit intact when password persistence fails', async () => {
      harness = await factory()
      await harness.bootstrap()
      await harness.run(`CREATE TRIGGER test_reject_owner_password
        BEFORE INSERT ON user_passwords
        BEGIN SELECT RAISE(ABORT, 'test password failure'); END`)

      await expect(harness.enroll()).rejects.toThrow(/test password failure/i)
      expect(await harness.rows(`SELECT user_id FROM user_passwords`)).toEqual([])
      expect(await harness.rows(`SELECT id FROM instance_bootstrap`)).toEqual([{ id: 1 }])
      expect(await harness.authenticate(token)).toMatchObject({ userId: 1 })
    })
  })
}

describe('instance bootstrap migration gate', () => {
  it('[unit] refuses an unmigrated database without creating application state', async () => {
    const client = new BetterSqlite3(':memory:')
    try {
      await expect(bootstrapInstanceContainer(client, input, options)).rejects.toThrow(
        /no such table: instance_bootstrap/i,
      )
      expect(
        client.prepare(`SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'`).get(),
      ).toEqual({ count: 0 })
    } finally {
      client.close()
    }
  })
})
