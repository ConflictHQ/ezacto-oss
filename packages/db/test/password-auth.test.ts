import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EmailAddressUnavailableError,
  FirstRunSignupUnavailableError,
  InvalidAuthTokenError,
  UnknownUserError,
  createContainerPasswordAuthService,
  createD1PasswordAuthService,
  type PasswordAuthService,
} from '../src/password-auth.js'
import { hashPassword } from '@ezacto/core'
import type * as Core from '@ezacto/core'

vi.mock('@ezacto/core', async (original) => {
  const actual = await original<typeof Core>()
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) }
})

import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  SessionCredentialChangedError,
  createContainerSessionStore,
  createD1SessionStore,
  type SessionStore,
} from '../src/sessions.js'

interface Harness {
  service: PasswordAuthService
  sessions: SessionStore
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
    sessions: createContainerSessionStore(database, { now: () => currentTime }),
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
    sessions: createD1SessionStore(database, { now: () => currentTime }),
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
      vi.mocked(hashPassword).mockClear()
      const verification = await harness.service.signup({
        organizationName: 'Halcyon Studio',
        firstName: 'Avery',
        lastName: 'Ng',
        email: 'Owner@Example.test',
        password,
        clientKey: '198.51.100.10',
      })
      expect(hashPassword).toHaveBeenCalledTimes(1)
      expect(verification).toMatchObject({
        kind: 'verify_email',
        to: 'owner@example.test',
        expiresAt: '2026-08-29T20:00:00.000Z',
      })
      expect(verification.token).toMatch(/^ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)
      expect(await harness.rows(`SELECT modules FROM organizations WHERE id = 1`)).toEqual([
        { modules: '{"approval":true,"expenses":true,"invoices":true,"team":true}' },
      ])

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

      vi.mocked(hashPassword).mockClear()
      await expect(harness.service.signup({
        organizationName: 'Another organization', firstName: 'Other', lastName: 'Owner',
        email: 'other@example.test', password, clientKey: '192.0.2.112',
      })).rejects.toBeInstanceOf(FirstRunSignupUnavailableError)
      expect(hashPassword).not.toHaveBeenCalled()

      const verifiedSignIn = await harness.service.signIn({
        email: 'OWNER@example.test',
        password,
        clientKey: '198.51.100.10',
      })
      expect(verifiedSignIn).toEqual({
        status: 'authenticated',
        credentialVersion: 1,
        principal: { userId: 1, profile: 'administrator', managerGrants: [] },
      })
      const activeSession = await harness.sessions.issue(1)
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

      vi.mocked(hashPassword).mockClear()
      await expect(harness.service.resetPassword(
        `ezacto_reset_${'X'.repeat(16)}_${'A'.repeat(43)}`, replacementPassword, '192.0.2.113',
      )).rejects.toBeInstanceOf(InvalidAuthTokenError)
      expect(hashPassword).not.toHaveBeenCalled()

      harness.setNow('2026-08-28T20:30:00.000Z')
      await expect(
        harness.service.resetPassword(reset!.token, replacementPassword, '198.51.100.10'),
      ).resolves.toEqual({ userId: 1, profile: 'administrator', managerGrants: [] })
      expect(hashPassword).toHaveBeenCalledTimes(1)
      await expect(
        harness.sessions.issue(
          1,
          verifiedSignIn.status === 'authenticated' ? verifiedSignIn.credentialVersion : undefined,
        ),
      ).rejects.toBeInstanceOf(SessionCredentialChangedError)
      await expect(harness.sessions.authenticate(activeSession.token)).resolves.toBeNull()
      await expect(harness.sessions.list(1)).resolves.toContainEqual(
        expect.objectContaining({
          id: activeSession.session.id,
          revocationReason: 'password_reset',
        }),
      )
      vi.mocked(hashPassword).mockClear()
      await expect(
        harness.service.resetPassword(reset!.token, replacementPassword, '198.51.100.10'),
      ).rejects.toBeInstanceOf(InvalidAuthTokenError)
      expect(hashPassword).not.toHaveBeenCalled()

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
      vi.mocked(hashPassword).mockClear()
      await expect(
        harness.service.resetPassword(
          expiredReset!.token,
          'another replacement password',
          '198.51.100.10',
        ),
      ).rejects.toBeInstanceOf(InvalidAuthTokenError)

      expect(hashPassword).not.toHaveBeenCalled()

      const stored = await harness.rows<{
        credential_version: number
        algorithm: string
        version: number | null
        iterations: number | null
        memory_kib: number | null
        time_cost: number | null
        parallelism: number | null
        salt: string
        password_hash: string
        selector: string
        secret_hash: string
      }>(
        `SELECT password.credential_version, password.algorithm, password.version, password.iterations,
           password.memory_kib, password.time_cost, password.parallelism,
           password.salt, password.password_hash, token.selector, token.secret_hash
         FROM user_passwords password JOIN auth_tokens token ON 1 = 1
         ORDER BY token.id`,
      )
      expect(stored).toHaveLength(3)
      for (const row of stored) {
        expect(row).toMatchObject({
          credential_version: 2,
          algorithm: 'argon2id',
          version: 19,
          iterations: null,
          memory_kib: 19_456,
          time_cost: 2,
          parallelism: 1,
        })
      }
      expect(JSON.stringify(stored)).not.toContain(password)
      expect(JSON.stringify(stored)).not.toContain(replacementPassword)
      expect(JSON.stringify(stored)).not.toContain(verification.token)
      expect(JSON.stringify(stored)).not.toContain(reset!.token)
      expect(JSON.stringify(stored)).not.toContain(expiredReset!.token)

      await expect(
        harness.execute(`UPDATE user_passwords SET salt = 'not-base64url' WHERE user_id = 1`),
      ).rejects.toThrow()
      await expect(
        harness.execute(`UPDATE user_passwords SET memory_kib = 1073741824 WHERE user_id = 1`),
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

    /**
     * #780. A claim nobody ever verified used to be permanent: whoever posted
     * to /auth/signup first owned the instance for ever, even if they never
     * opened the mail, and the real operator's only route back was the
     * database.
     */
    describe('an abandoned first-run claim', () => {
      let abandoned: Harness

      beforeAll(async () => {
        abandoned = await factory()
        await abandoned.service.signup({
          organizationName: 'Squatter Org',
          firstName: 'First',
          lastName: 'Claimant',
          email: 'squatter@example.test',
          password,
          clientKey: '198.51.100.50',
        })
      })

      afterAll(async () => abandoned.close())

      it('transfers to the next claimant, rewriting the identity in place', async () => {
        const verification = await abandoned.service.signup({
          organizationName: 'Real Studio',
          firstName: 'Avery',
          lastName: 'Ng',
          email: 'real@example.test',
          password: replacementPassword,
          clientKey: '198.51.100.51',
        })
        expect(verification).toMatchObject({ kind: 'verify_email', to: 'real@example.test' })
        expect(
          await abandoned.rows(`SELECT name FROM organizations WHERE id = 1`),
        ).toEqual([{ name: 'Real Studio' }])
        expect(
          await abandoned.rows(
            `SELECT first_name AS firstName, last_name AS lastName FROM users WHERE id = 1`,
          ),
        ).toEqual([{ firstName: 'Avery', lastName: 'Ng' }])
        expect(
          await abandoned.rows(`SELECT address FROM user_emails WHERE id = 1`),
        ).toEqual([{ address: 'real@example.test' }])
      })

      it('[security] leaves the first claimant no way back in', async () => {
        // Their verification mail is still in their inbox. If the token
        // survived the transfer they could open it afterwards and verify an
        // address that is no longer theirs.
        expect(
          await abandoned.rows(
            `SELECT count(*) AS live FROM auth_tokens
             WHERE user_email_id = 1 AND kind = 'verify_email' AND used_at IS NULL`,
          ),
        ).toEqual([{ live: 1 }])
        expect(
          await abandoned.rows(`SELECT address FROM user_emails WHERE id = 1`),
        ).toEqual([{ address: 'real@example.test' }])
      })

      it('[security] keeps exactly one owner throughout, which is why it transfers rather than deletes', async () => {
        expect(
          await abandoned.rows(`SELECT user_id AS userId FROM organization_owner WHERE id = 1`),
        ).toEqual([{ userId: 1 }])
        expect(
          await abandoned.rows(`SELECT is_owner AS isOwner FROM users WHERE id = 1`),
        ).toEqual([{ isOwner: 1 }])
      })

      it('[security] stops being transferable the moment an address is verified', async () => {
        const verified = await factory()
        const claim = await verified.service.signup({
          organizationName: 'Settled Org',
          firstName: 'Settled',
          lastName: 'Owner',
          email: 'settled@example.test',
          password,
          clientKey: '198.51.100.60',
        })
        await verified.service.verifyEmail(claim.token, '198.51.100.60')
        await expect(
          verified.service.signup({
            organizationName: 'Too Late',
            firstName: 'Too',
            lastName: 'Late',
            email: 'toolate@example.test',
            password,
            clientKey: '198.51.100.61',
          }),
        ).rejects.toBeInstanceOf(FirstRunSignupUnavailableError)
        expect(
          await verified.rows(`SELECT name FROM organizations WHERE id = 1`),
        ).toEqual([{ name: 'Settled Org' }])
        await verified.close()
      })
    })

    it('[security #1124] keeps reset single-use when two callers pass the cheap check', async () => {
      const concurrent = await factory()
      try {
        const verification = await concurrent.service.signup({
          organizationName: 'Concurrent', firstName: 'Reset', lastName: 'Owner',
          email: 'concurrent@example.test', password, clientKey: '192.0.2.114',
        })
        await concurrent.service.verifyEmail(verification.token, '192.0.2.114')
        const reset = await concurrent.service.requestPasswordReset('concurrent@example.test', '192.0.2.114')
        const results = await Promise.allSettled([
          concurrent.service.resetPassword(reset!.token, replacementPassword, '192.0.2.115'),
          concurrent.service.resetPassword(reset!.token, replacementPassword, '192.0.2.116'),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toEqual([
          expect.objectContaining({ reason: expect.any(InvalidAuthTokenError) }),
        ])
        expect(await concurrent.rows('SELECT credential_version FROM user_passwords')).toEqual([
          { credential_version: 2 },
        ])
      } finally {
        await concurrent.close()
      }
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

    it('[security] adds and verifies a work address without moving the primary', async () => {
      harness.setNow('2026-08-31T09:00:00.000Z')
      const delivery = await harness.service.addEmail({
        userId: 1,
        email: 'Owner@Work.test',
        clientKey: '198.51.100.42',
      })
      expect(delivery).toMatchObject({
        kind: 'verify_email',
        to: 'owner@work.test',
        expiresAt: '2026-09-01T09:00:00.000Z',
      })
      // Pending and non-primary the moment it is added. The personal address is
      // how time entries match Deel and Wise, so it has to stay primary.
      expect(
        await harness.rows<{ address: string; verified_at: string | null; is_primary: number }>(
          `SELECT address, verified_at, is_primary FROM user_emails
           WHERE user_id = 1 ORDER BY id`,
        ),
      ).toEqual([
        { address: 'owner@example.test', verified_at: expect.any(String), is_primary: 1 },
        { address: 'owner@work.test', verified_at: null, is_primary: 0 },
      ])

      await expect(harness.service.verifyEmail(delivery.token, '198.51.100.42')).resolves.toMatchObject(
        { userId: 1 },
      )
      expect(
        await harness.rows<{ address: string; verified_at: string | null; is_primary: number }>(
          `SELECT address, verified_at, is_primary FROM user_emails
           WHERE user_id = 1 ORDER BY id`,
        ),
      ).toEqual([
        { address: 'owner@example.test', verified_at: expect.any(String), is_primary: 1 },
        {
          address: 'owner@work.test',
          verified_at: '2026-08-31T09:00:00.000Z',
          is_primary: 0,
        },
      ])
      // Both addresses now sign the same person in.
      await expect(
        harness.service.signIn({
          email: 'owner@work.test',
          password: replacementPassword,
          clientKey: '198.51.100.42',
        }),
      ).resolves.toMatchObject({ status: 'authenticated', principal: { userId: 1 } })
    })

    it('[security] refuses an address another account already holds, and an unknown user', async () => {
      harness.setNow('2026-08-31T10:00:00.000Z')
      await harness.execute(
        `INSERT INTO users (
          id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at
        ) VALUES (2, 'Other', 'Person', 'member', '[]', 0, ?, ?)`,
        '2026-08-31T10:00:00.000Z',
        '2026-08-31T10:00:00.000Z',
      )
      await harness.execute(
        `INSERT INTO user_emails (
          user_id, address, verified_at, is_primary, created_at, updated_at
        ) VALUES (2, 'other@example.test', ?, 1, ?, ?)`,
        '2026-08-31T10:00:00.000Z',
        '2026-08-31T10:00:00.000Z',
        '2026-08-31T10:00:00.000Z',
      )
      await expect(
        harness.service.addEmail({
          userId: 1,
          email: 'other@example.test',
          clientKey: '198.51.100.43',
        }),
      ).rejects.toBeInstanceOf(EmailAddressUnavailableError)
      await expect(
        harness.service.addEmail({
          userId: 404,
          email: 'ghost@work.test',
          clientKey: '198.51.100.44',
        }),
      ).rejects.toBeInstanceOf(UnknownUserError)
      expect(
        await harness.rows(`SELECT id FROM user_emails WHERE lower(address) = 'ghost@work.test'`),
      ).toEqual([])
    })
  })
}
