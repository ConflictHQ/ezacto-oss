import { build } from 'esbuild'
import { createD1Database } from '../../../packages/db/src/adapters.js'
import { createTimesheetApprovalRepository } from '../../../packages/db/src/timesheet-approvals.js'
import { seedAutomaticApprovalFixture } from '../../../packages/db/test/support/automatic-approval-fixture.js'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const cursorSecret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'
const miniflares: Miniflare[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

/** A real invocation of the deployed minute cron, at the current test clock. */
const minuteCron = `https://worker.test/cdn-cgi/handler/scheduled?time=${Date.now()}&cron=*+*+*+*+*`

const createTestWorker = async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    external: ['node:async_hooks'],
    target: 'es2022',
    write: false,
  })
  const miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: 'test',
      RELEASE: 'automatic-approval-scheduled-test',
    },
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  })
  miniflares.push(miniflare)
  // Any data request applies the migrations.
  await miniflare.dispatchFetch('https://worker.test/api/v1')
  return miniflare
}

describe('automatic approval minute cron', () => {
  it('[integration #1009] approves once through the deployed Worker and records its system receipt', async () => {
    const miniflare = await createTestWorker()
    const database = await miniflare.getD1Database('DB')
    const submitted = await seedAutomaticApprovalFixture(async (statement, ...bindings) => {
      await database
        .prepare(statement)
        .bind(...bindings)
        .run()
    }, new Date().toISOString())
    await createTimesheetApprovalRepository(createD1Database(database)).submit(
      1,
      '2026-08-24',
      '2026-08-30',
      submitted,
    )
    expect((await miniflare.dispatchFetch(minuteCron)).status).toBe(200)
    expect((await miniflare.dispatchFetch(minuteCron)).status).toBe(200)
    const receipts = (
      await database
        .prepare(
          'SELECT submission_id,authorized_by_user_id FROM timesheet_automatic_approval_receipts',
        )
        .all()
    ).results
    expect(receipts).toEqual([{ submission_id: 1, authorized_by_user_id: 10 }])
    expect(
      (
        await database
          .prepare(
            "SELECT json_extract(event.payload_json,'$.actor.type') AS actor_type FROM activity_log activity JOIN event_outbox event ON event.id=activity.event_id WHERE event.event_type='timesheet.approved'",
          )
          .all()
      ).results,
    ).toEqual([{ actor_type: 'system' }])
    expect(
      await database.prepare('SELECT status FROM timesheet_submissions WHERE id=1').first(),
    ).toEqual({ status: 'approved' })
  })
})
