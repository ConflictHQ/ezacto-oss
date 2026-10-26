import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfiguredBankFeedRuntime } from '../../integrations/src/bank-feed/runtime.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createBankDepositIngestionService } from '../src/bank-deposit-review.js'
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((f) => f()))
})
const setup = async (kind: 'sqlite' | 'd1') => {
  const sqlite = kind === 'sqlite' ? new BetterSqlite3(':memory:') : null
  const mf = sqlite
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: ['DB'],
      })
  const raw = mf ? await mf.getD1Database('DB') : null
  if (sqlite) migrateContainer(sqlite)
  else await migrateD1(raw!)
  disposals.push(async () => {
    sqlite?.close()
    await mf?.dispose()
  })
  const db = sqlite ? createContainerDatabase(sqlite) : createD1Database(raw!)
  return { db, store: createBankDepositIngestionService(db) }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(kind + ' bank feed polling', () => {
    it('persists exact scan scope across pages, deduplicates replay and advances cursor only with staged rows', async () => {
      const f = await setup(kind),
        urls: URL[] = []
      let clock = new Date()
      const original = clock.getTime(),
        date = new Date(original - 86400000).toISOString()
      const fetcher = (async (input: URL | RequestInfo) => {
        const url = new URL(String(input))
        urls.push(url)
        const second = url.searchParams.has('start_after')
        return new Response(
          JSON.stringify({
            transactions: [
              {
                id: second ? 'txn_two' : 'txn_one',
                accountId: 'owned_account',
                amount: 10,
                kind: 'incomingDomesticWire',
                status: 'sent',
                postedAt: date,
                externalMemo: 'Owned memo',
                counterpartyName: 'Owned sender',
              },
            ],
            page: { nextPage: second ? null : 'not_the_last_id' },
          }),
        )
      }) as typeof fetch
      const runtime = createConfiguredBankFeedRuntime({
        environment: {
          MERCURY_BANK_FEED_TOKEN: 'owned',
          MERCURY_BANK_FEED_ACCOUNT_ID: 'owned_account',
          MERCURY_BANK_FEED_CURRENCY: 'USD',
        },
        store: f.store,
        now: () => clock,
        fetchImplementation: fetcher,
      })
      expect(await runtime.processDue()).toEqual({ checked: 1, failed: 0 })
      clock = new Date(original + 1000)
      expect(await runtime.processDue()).toEqual({ checked: 1, failed: 0 })
      expect(urls[0]!.searchParams.get('postedEnd')).toBe(urls[1]!.searchParams.get('postedEnd'))
      expect(urls[1]!.searchParams.get('start_after')).toBe('txn_one')
      expect(await runtime.processDue()).toEqual({ checked: 0, failed: 0 })
      expect(await f.db.all(sql`SELECT id FROM bank_deposits`)).toHaveLength(2)
      expect(await f.db.all(sql`SELECT id FROM invoice_payments`)).toHaveLength(0)
      clock = new Date(original + 6 * 60000)
      expect(await runtime.processDue()).toEqual({ checked: 1, failed: 0 })
      expect(urls[2]!.searchParams.get('postedEnd')).not.toBe(
        urls[0]!.searchParams.get('postedEnd'),
      )
      expect(await f.db.all(sql`SELECT id FROM bank_deposits`)).toHaveLength(2)
    })
    it('failed reads preserve cursor and partial configuration leaves the rest of the application available', async () => {
      const f = await setup(kind)
      const runtime = createConfiguredBankFeedRuntime({
        environment: {
          MERCURY_BANK_FEED_TOKEN: 'owned',
          MERCURY_BANK_FEED_ACCOUNT_ID: 'owned_account',
          MERCURY_BANK_FEED_CURRENCY: 'USD',
        },
        store: f.store,
        fetchImplementation: (async () =>
          new Response('private token must not leak', { status: 403 })) as typeof fetch,
      })
      expect(await runtime.processDue()).toEqual({ checked: 0, failed: 1 })
      expect((await runtime.status())[0]).toMatchObject({
        configured: true,
        last_error: 'permission_denied',
      })
      expect(await f.db.all(sql`SELECT cursor FROM bank_feed_accounts`)).toEqual([{ cursor: null }])
      const invalid = createConfiguredBankFeedRuntime({
        environment: { WISE_BANK_FEED_TOKEN: 'owned' },
        store: f.store,
      })
      expect(await invalid.processDue()).toEqual({ checked: 0, failed: 0 })
      expect((await invalid.status())[1]).toMatchObject({
        configured: false,
        last_error: 'configuration_invalid',
      })
    })
  })
