import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FirstRunSignupUnavailableError,
  InvalidAuthTokenError,
  createContainerPasswordAuthService,
  createD1PasswordAuthService,
  type PasswordAuthService,
} from '../src/password-auth.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  service: PasswordAuthService
  setNow(value: string): void
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  execute(query: string, ...bindings: unknown[]): Promise<void>
  close(): Promise<void>
}

const initialTime = '2026-08-28T20:00:00.000Z'
const password = 'correct horse battery staple 🙂'
const replacementPassword = 'new correct horse battery staple 🔐'

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  let currentTime = initialTime
  return {
    service: createContainerPasswordAuthService(database, { now: () => currentTime }),
    setNow: (value) => {
      currentTime = value
    },
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      database.prepare(query).all(...bindings) as T[],
    execute: async (query: string, ...bindings: unknown[]) => {
      database.prepare(query).run(...bindings)
    },
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
  let currentTime = initialTime
  return {
    service: createD1PasswordAuthService(database, { now: () => currentTime }),
    setNow: (value) => {
      currentTime = value
    },
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(query)
          .bind(...bindings)
          .all<T>()
      ).results,
    execute: async (query: string, ...bindings: unknown[]) => {
      await database
        .prepare(query)
        .bind(...bindings)
        .run()
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories) {
  describe(`password auth (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory()
    })

    afterAll(async () => harness.close())

    it('[e2e:first-run] signs up, verifies, signs in, and resets exactly once', async () => {
      const verification = await harness.service.signup({
        organizationName: 'Halcyon Studio',
        firstName: 'Avery',
        lastName: 'Ng',
        email: 'Owner@Example.test',
        password,
        clientKey: '198.51.100.10',
      })
      expect(verification).toMatchObject({
        kind: 'verify_email',
        to: 'owner@example.test',
        expiresAt: '2026-08-29T20:00:00.000Z',
      })
      expect(verification.token).toMatch(/^ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)

      await expect(
        harness.service.signIn({
          email: 'owner@example.test',
          password,
          clientKey: '198.51.100.10',
        }),
      ).resolves.toEqual({ status: 'verification_required' })

      await expect(
        harness.service.verifyEmail(verification.token, '198.51.100.10'),
      ).resolves.toEqual({
        userId: 1,
        profile: 'administrator',
        managerGrants: [],
      })
      await expect(
        harness.service.verifyEmail(verification.token, '198.51.100.10'),
      ).rejects.toBeInstanceOf(InvalidAuthTokenError)

      await expect(
        harness.service.signIn({
          email: 'OWNER@example.test',
          password,
          clientKey: '198.51.100.10',
        }),
      ).resolves.toEqual({
        status: 'authenticated',
        principal: { userId: 1, profile: 'administrator', managerGrants: [] },
      })
      await expect(
        harness.service.signIn({
          email: 'owner@example.test',
          password: 'incorrect password value',
          clientKey: '198.51.100.10',
        }),
      ).resolves.toEqual({ status: 'invalid_credentials' })

      await expect(
        harness.service.requestPasswordReset('unknown@example.test', '198.51.100.10'),
      ).resolves.toBeNull()
      const reset = await harness.service.requestPasswordReset(
        'owner@example.test',
        '198.51.100.10',
      )
      expect(reset).toMatchObject({
        kind: 'password_reset',
        to: 'owner@example.test',
        expiresAt: '2026-08-28T21:00:00.000Z',
      })
      expect(reset?.token).toMatch(/^ezacto_reset_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)

      harness.setNow('2026-08-28T20:30:00.000Z')
      await expect(
        harness.service.resetPassword(reset!.token, replacementPassword, '198.51.100.10'),
      ).resolves.toEqual({ userId: 1, profile: 'administrator', managerGrants: [] })
      await expect(
        harness.service.resetPassword(reset!.token, replacementPassword, '198.51.100.10'),
      ).rejects.toBeInstanceOf(InvalidAuthTokenError)

      await expect(
        harness.service.signIn({
          email: 'owner@example.test',
          password,
          clientKey: '198.51.100.10',
        }),
      ).resolves.toEqual({ status: 'invalid_credentials' })
      await expect(
        harness.service.signIn({
          email: 'owner@example.test',
          password: replacementPassword,
          clientKey: '198.51.100.10',
        }),
      ).resolves.toMatchObject({ status: 'authenticated' })

      const expiredReset = await harness.service.requestPasswordReset(
        'owner@example.test',
        '198.51.100.10',
      )
      expect(expiredReset?.expiresAt).toBe('2026-08-28T21:30:00.000Z')
      harness.setNow('2026-08-28T21:30:00.000Z')
      await expect(
        harness.service.resetPassword(
          expiredReset!.token,
          'another replacement password',
          '198.51.100.10',
        ),
      ).rejects.toBeInstanceOf(InvalidAuthTokenError)

      const stored = await harness.rows<{
        salt: string
        password_hash: string
        selector: string
        secret_hash: string
      }>(
        `SELECT password.salt, password.password_hash, token.selector, token.secret_hash
         FROM user_passwords password JOIN auth_tokens token ON 1 = 1
         ORDER BY token.id`,
      )
      expect(stored).toHaveLength(3)
      expect(JSON.stringify(stored)).not.toContain(password)
      expect(JSON.stringify(stored)).not.toContain(replacementPassword)
      expect(JSON.stringify(stored)).not.toContain(verification.token)
      expect(JSON.stringify(stored)).not.toContain(reset!.token)
      expect(JSON.stringify(stored)).not.toContain(expiredReset!.token)

      await expect(
        harness.execute(`UPDATE user_passwords SET salt = 'not-base64url' WHERE user_id = 1`),
      ).rejects.toThrow()
      await expect(
        harness.execute(`UPDATE auth_tokens SET secret_hash = ? WHERE id = 1`, '0'.repeat(64)),
      ).rejects.toThrow(/single-use|immutable|constraint/i)

      await expect(
        harness.rows<{ isOwner: number }>(`SELECT is_owner AS isOwner FROM users WHERE id = 1`),
      ).resolves.toEqual([{ isOwner: 1 }])

      await expect(
        harness.service.signup({
          organizationName: 'Attacker Org',
          firstName: 'Another',
          lastName: 'Owner',
          email: 'another@example.test',
          password,
          clientKey: '203.0.113.4',
        }),
      ).rejects.toBeInstanceOf(FirstRunSignupUnavailableError)
    })

    it('[unit] rate-limits attempt buckets and resets at the exact window boundary', async () => {
      harness.setNow('2026-08-30T00:00:00.000Z')
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          harness.service.requestPasswordReset('nobody@example.test', '203.0.113.99'),
        ).resolves.toBeNull()
      }
      await expect(
        harness.service.requestPasswordReset('nobody@example.test', '203.0.113.99'),
      ).rejects.toMatchObject({ retryAfterSeconds: 3_600 })

      harness.setNow('2026-08-30T01:00:00.000Z')
      await expect(
        harness.service.requestPasswordReset('nobody@example.test', '203.0.113.99'),
      ).resolves.toBeNull()

      harness.setNow('2026-08-30T02:00:00.000Z')
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          harness.service.requestPasswordReset(
            'distributed-target@example.test',
            `203.0.113.${attempt + 1}`,
          ),
        ).resolves.toBeNull()
      }
      await expect(
        harness.service.requestPasswordReset('distributed-target@example.test', '203.0.113.6'),
      ).rejects.toMatchObject({ retryAfterSeconds: 3_600 })

      harness.setNow('2026-08-30T04:00:00.000Z')
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          harness.service.requestPasswordReset(
            `rotating-target-${attempt}@example.test`,
            '203.0.113.50',
          ),
        ).resolves.toBeNull()
      }
      await expect(
        harness.service.requestPasswordReset('rotating-target-5@example.test', '203.0.113.50'),
      ).rejects.toMatchObject({ retryAfterSeconds: 3_600 })

      harness.setNow('2026-08-30T06:00:00.000Z')
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(
          harness.service.verifyEmail('malformed-token', '203.0.113.75'),
        ).rejects.toBeInstanceOf(InvalidAuthTokenError)
      }
      await expect(
        harness.service.verifyEmail('malformed-token', '203.0.113.75'),
      ).rejects.toMatchObject({ retryAfterSeconds: 900 })
    })
  })
}
