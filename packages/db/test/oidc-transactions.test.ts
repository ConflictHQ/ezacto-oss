import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createContainerOidcTransactionStore,
  createD1OidcTransactionStore,
  type OidcTransactionStore,
} from '../src/oidc-transactions.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  store: OidcTransactionStore
  execute(query: string, ...bindings: unknown[]): Promise<void>
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    store: createContainerOidcTransactionStore(database),
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
  return {
    store: createD1OidcTransactionStore(database),
    execute: async (query, ...bindings) => {
      await database.prepare(query).bind(...bindings).run()
    },
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      (await database.prepare(query).bind(...bindings).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const digest = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const transaction = async (rawState = 'browser-state-secret') => ({
  provider: 'google',
  issuer: 'https://accounts.example.test/',
  clientId: 'test-client',
  clientKeyHash: await digest('198.51.100.8'),
  stateHash: await digest(rawState),
  codeVerifier: 'v'.repeat(43),
  nonce: 'n'.repeat(43),
  redirectUri: 'https://ezacto.io/auth/oidc/google/callback',
  createdAt: '2026-08-28T00:00:00.000Z',
  expiresAt: '2026-08-28T00:10:00.000Z',
  rateWindowStart: '2026-08-27T23:50:00.000Z',
  cleanupBefore: '2026-08-27T00:00:00.000Z',
})

for (const [runtime, factory] of [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const) {
  describe(`OIDC transaction store (${runtime})`, () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await factory()
    })

    afterEach(async () => harness.close())

    it('[security] stores only a state digest and consumes a transaction exactly once', async () => {
      const input = await transaction()
      await expect(harness.store.create(input)).resolves.toBe('created')
      await expect(harness.store.create(input)).resolves.toBe('collision')

      await expect(
        harness.store.consume('google', input.stateHash, '2026-08-28T00:05:00.000Z'),
      ).resolves.toMatchObject({
        provider: 'google',
        issuer: input.issuer,
        clientId: input.clientId,
        codeVerifier: input.codeVerifier,
        nonce: input.nonce,
        redirectUri: input.redirectUri,
        consumedAt: '2026-08-28T00:05:00.000Z',
      })
      await expect(
        harness.store.consume('google', input.stateHash, '2026-08-28T00:05:01.000Z'),
      ).resolves.toBeNull()

      const rows = await harness.rows<Record<string, unknown>>(
        'SELECT * FROM oidc_transactions',
      )
      expect(rows).toHaveLength(1)
      expect(Object.values(rows[0]!).join(' ')).not.toContain('browser-state-secret')
      expect(Object.values(rows[0]!).join(' ')).not.toContain('198.51.100.8')
      expect(Object.keys(rows[0]!)).not.toContain('authorization_code')
      expect(Object.keys(rows[0]!)).not.toContain('access_token')
      expect(Object.keys(rows[0]!)).not.toContain('id_token')
      expect(Object.keys(rows[0]!)).not.toContain('refresh_token')
    })

    it('[security] bounds starts per hashed client and cleans expired transactions', async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await expect(
          harness.store.create(await transaction(`rate-state-${attempt}`)),
        ).resolves.toBe('created')
      }
      await expect(
        harness.store.create(await transaction('rate-state-blocked')),
      ).resolves.toBe('rate_limited')

      await expect(
        harness.store.create({
          ...(await transaction('other-client-state')),
          clientKeyHash: await digest('203.0.113.9'),
        }),
      ).resolves.toBe('created')

      const later = {
        ...(await transaction('later-state')),
        createdAt: '2026-08-28T00:11:00.000Z',
        expiresAt: '2026-08-28T00:21:00.000Z',
        rateWindowStart: '2026-08-28T00:01:00.000Z',
        cleanupBefore: '2026-08-27T00:11:00.000Z',
      }
      await expect(harness.store.create(later)).resolves.toBe('created')
      await expect(
        harness.rows<{ count: number }>('SELECT count(*) AS count FROM oidc_transactions'),
      ).resolves.toEqual([{ count: 1 }])
    })

    it('[security] refuses expired, wrong-provider, and consumed-state rollback attempts', async () => {
      const input = await transaction('second-browser-state')
      await harness.store.create(input)
      await expect(
        harness.store.consume('second', input.stateHash, '2026-08-28T00:05:00.000Z'),
      ).resolves.toBeNull()
      await expect(
        harness.store.consume('google', input.stateHash, input.expiresAt),
      ).resolves.toBeNull()

      const fresh = {
        ...(await transaction('third-browser-state')),
        expiresAt: '2026-08-28T00:20:00.000Z',
      }
      await harness.store.create(fresh)
      await harness.store.consume('google', fresh.stateHash, '2026-08-28T00:05:00.000Z')
      await expect(
        harness.execute(
          `UPDATE oidc_transactions
            SET consumed_at = NULL, consume_nonce = NULL, updated_at = ?
            WHERE state_hash = ?`,
          '2026-08-28T00:06:00.000Z',
          fresh.stateHash,
        ),
      ).rejects.toThrow(/immutable|irreversible/)
    })
  })
}
