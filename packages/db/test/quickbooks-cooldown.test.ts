import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { createD1Database } from '../src/adapters.js'
import { createQuickBooksStore } from '../src/quickbooks.js'
import { quickBooksRecoveryMigration } from '../src/migrations/0133_quickbooks_recovery.js'
import { quickBooksRetryMigration } from '../src/migrations/0154_quickbooks_retry.js'

let miniflare: Miniflare | undefined
afterEach(async () => miniflare?.dispose())

it('[D1] upgrades a saved cursor and keeps the longest retry time across store restarts', async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default {}', d1Databases: ['DB'] })
  const d1 = await miniflare.getD1Database('DB')
  for (const statement of quickBooksRecoveryMigration) await d1.prepare(statement).run()
  const at = '2026-10-23T12:00:00.000Z'
  await d1
    .prepare(
      `INSERT INTO quickbooks_sync_cursors (realm_id,cdc_cursor,last_run_at,last_outcome)
    VALUES ('realm-a',?,?, 'caught_up')`,
    )
    .bind(at, at)
    .run()
  for (const statement of quickBooksRetryMigration) await d1.prepare(statement).run()
  const store = createQuickBooksStore(createD1Database(d1))
  expect(await store.readSyncCursor('realm-a')).toMatchObject({
    cdcCursor: at,
    retryNotBefore: null,
  })
  await store.recordSyncOutcome({
    realmId: 'realm-a',
    lastRunAt: at,
    lastOutcome: 'failed',
    retryNotBefore: '2026-10-23T14:00:00.000Z',
  })
  const restarted = createQuickBooksStore(createD1Database(d1))
  await restarted.recordSyncOutcome({
    realmId: 'realm-a',
    lastRunAt: at,
    lastOutcome: 'failed',
    retryNotBefore: '2026-10-23T12:01:00.000Z',
  })
  await restarted.recordSyncOutcome({ realmId: 'realm-a', lastRunAt: at, lastOutcome: 'failed' })
  expect(await restarted.readSyncCursor('realm-a')).toMatchObject({
    cdcCursor: at,
    retryNotBefore: '2026-10-23T14:00:00.000Z',
  })
  await restarted.saveSyncCursor({
    realmId: 'realm-b',
    cdcCursor: at,
    lastRunAt: at,
    lastOutcome: 'caught_up',
  })
  expect(await restarted.readSyncCursor('realm-b')).toMatchObject({ retryNotBefore: null })
})
