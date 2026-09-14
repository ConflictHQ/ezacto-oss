import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createContainerStaffMagicLinkStore,
  createD1StaffMagicLinkStore,
  type StaffMagicLinkStore,
} from '../src/staff-magic-links.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  store: StaffMagicLinkStore
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    store: createContainerStaffMagicLinkStore(database),
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
    store: createD1StaffMagicLinkStore(database),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      (await database.prepare(query).bind(...bindings).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const digest = async (value: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const link = async (overrides = {}) => ({
  userId: 42,
  tokenHash: await digest('link-token-secret'),
  codeHash: await digest('123456'),
  flow: 'app' as const,
  createdAt: '2026-08-28T00:00:00.000Z',
  expiresAt: '2026-08-28T00:15:00.000Z',
  cleanupBefore: '2026-08-27T00:00:00.000Z',
  ...overrides,
})

for (const [runtime, factory] of [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const) {
  describe(`staff magic link store (${runtime})`, () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await factory()
    })

    afterEach(async () => {
      await harness.close()
    })

    it('redeems the link token once, returning the user and flow', async () => {
      expect(await harness.store.create(await link())).toBe('created')
      const first = await harness.store.consumeByToken(
        await digest('link-token-secret'),
        '2026-08-28T00:05:00.000Z'
      )
      expect(first).toEqual({ userId: 42, flow: 'app' })
      expect(
        await harness.store.consumeByToken(
          await digest('link-token-secret'),
          '2026-08-28T00:06:00.000Z'
        )
      ).toBeNull()
    })

    it('redeems the code once, and a used record blocks the token path too', async () => {
      await harness.store.create(await link())
      const byCode = await harness.store.consumeByCode(
        42,
        await digest('123456'),
        '2026-08-28T00:05:00.000Z',
        5
      )
      expect(byCode).toEqual({ userId: 42, flow: 'app' })
      // Single-use across paths: the token no longer works.
      expect(
        await harness.store.consumeByToken(
          await digest('link-token-secret'),
          '2026-08-28T00:06:00.000Z'
        )
      ).toBeNull()
    })

    it('locks the code after the attempt ceiling, even with the right code', async () => {
      await harness.store.create(await link())
      const wrong = await digest('000000')
      for (let i = 0; i < 5; i += 1) {
        expect(
          await harness.store.consumeByCode(42, wrong, '2026-08-28T00:05:00.000Z', 5)
        ).toBeNull()
      }
      // Ceiling reached — the correct code is now refused.
      expect(
        await harness.store.consumeByCode(
          42,
          await digest('123456'),
          '2026-08-28T00:06:00.000Z',
          5
        )
      ).toBeNull()
      const [row] = await harness.rows<{ attempts: number }>(
        'SELECT attempts FROM staff_magic_links WHERE user_id = 42'
      )
      expect(row?.attempts).toBe(5)
    })

    it('does not redeem an expired link by token or code', async () => {
      await harness.store.create(await link())
      const past = '2026-08-28T00:20:00.000Z'
      expect(
        await harness.store.consumeByToken(await digest('link-token-secret'), past)
      ).toBeNull()
      expect(
        await harness.store.consumeByCode(42, await digest('123456'), past, 5)
      ).toBeNull()
    })

    it('reports a collision on a duplicate token hash', async () => {
      expect(await harness.store.create(await link())).toBe('created')
      expect(await harness.store.create(await link())).toBe('collision')
    })

    it('sweeps expired and consumed rows on create', async () => {
      await harness.store.create(await link({ tokenHash: await digest('first') }))
      await harness.store.consumeByToken(
        await digest('first'),
        '2026-08-28T00:05:00.000Z'
      )
      await harness.store.create(
        await link({
          tokenHash: await digest('second'),
          createdAt: '2026-08-28T01:00:00.000Z',
          expiresAt: '2026-08-28T01:15:00.000Z',
          cleanupBefore: '2026-08-28T00:30:00.000Z',
        })
      )
      const [row] = await harness.rows<{ count: number }>(
        'SELECT count(*) AS count FROM staff_magic_links'
      )
      expect(row?.count).toBe(1)
    })
  })
}
