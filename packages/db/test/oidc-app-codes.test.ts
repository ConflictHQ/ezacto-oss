import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createContainerOidcAppCodeStore,
  createD1OidcAppCodeStore,
  type OidcAppCodeStore,
} from '../src/oidc-app-codes.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  store: OidcAppCodeStore
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    store: createContainerOidcAppCodeStore(database),
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
    store: createD1OidcAppCodeStore(database),
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

const digest = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const code = async (raw = 'app-code-secret', overrides = {}) => ({
  provider: 'google',
  codeHash: await digest(raw),
  userId: 42,
  createdAt: '2026-08-28T00:00:00.000Z',
  expiresAt: '2026-08-28T00:02:00.000Z',
  cleanupBefore: '2026-08-27T00:00:00.000Z',
  ...overrides,
})

for (const [runtime, factory] of [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const) {
  describe(`OIDC app code store (${runtime})`, () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await factory()
    })

    afterEach(async () => {
      await harness.close()
    })

    it('creates a code and consumes it once, returning the bound user', async () => {
      expect(await harness.store.create(await code())).toBe('created')
      const consumed = await harness.store.consume(
        await digest('app-code-secret'),
        '2026-08-28T00:01:00.000Z',
      )
      expect(consumed?.userId).toBe(42)
      expect(consumed?.provider).toBe('google')
    })

    it('refuses a second consumption of the same code', async () => {
      await harness.store.create(await code())
      const hash = await digest('app-code-secret')
      expect((await harness.store.consume(hash, '2026-08-28T00:01:00.000Z'))?.userId).toBe(42)
      expect(await harness.store.consume(hash, '2026-08-28T00:01:30.000Z')).toBeNull()
    })

    it('will not consume an expired code', async () => {
      await harness.store.create(await code())
      expect(
        await harness.store.consume(await digest('app-code-secret'), '2026-08-28T00:03:00.000Z'),
      ).toBeNull()
    })

    it('returns null for an unknown code', async () => {
      expect(
        await harness.store.consume(await digest('never-issued'), '2026-08-28T00:01:00.000Z'),
      ).toBeNull()
    })

    it('reports a collision on a duplicate code hash', async () => {
      expect(await harness.store.create(await code())).toBe('created')
      expect(await harness.store.create(await code())).toBe('collision')
    })

    it('sweeps expired and consumed rows on create', async () => {
      await harness.store.create(await code('first'))
      await harness.store.consume(await digest('first'), '2026-08-28T00:01:00.000Z')
      // A later create past the first code's expiry sweeps it.
      await harness.store.create(
        await code('second', {
          createdAt: '2026-08-28T01:00:00.000Z',
          expiresAt: '2026-08-28T01:02:00.000Z',
          cleanupBefore: '2026-08-28T00:30:00.000Z',
        }),
      )
      const remaining = await harness.rows<{ count: number }>(
        'SELECT count(*) AS count FROM oidc_app_codes',
      )
      expect(remaining[0]?.count).toBe(1)
    })
  })
}
