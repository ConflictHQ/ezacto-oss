import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { scheduledJobConfig } from '@ezacto/core'
import { createD1Database } from '../../../packages/db/src/adapters.js'
import { createScheduledJobsService } from '../../../packages/db/src/scheduled-jobs.js'
import { seedMonthEndJobFixture } from '../../../packages/db/test/support/month-end-job-fixture.js'
let worker: Miniflare | undefined
afterEach(async () => worker?.dispose())
it('[integration #63] the real minute cron proposes one manifest and never confirms or sends it', async () => {
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
  worker = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE',
      ENVIRONMENT: 'test',
      RELEASE: 'scheduled-job-test',
    },
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  })
  await worker.dispatchFetch('https://worker.test/api/v1')
  const d1 = await worker.getD1Database('DB'),
    database = createD1Database(d1)
  const now = new Date(),
    period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
      .toISOString()
      .slice(0, 7)
  await seedMonthEndJobFixture(database, period, now.toISOString())
  const service = createScheduledJobsService(database)
  await service.create(
    1,
    scheduledJobConfig({ name: 'Monthly A', cadence: '0 0 1 * *', scope: { client_ids: [1] } }),
    now.toISOString(),
  )
  await service.create(
    1,
    scheduledJobConfig({ name: 'Paused', cadence: '0 0 1 * *', is_active: false }),
    now.toISOString(),
  )
  const tick = () =>
    worker!.dispatchFetch(
      `https://worker.test/cdn-cgi/handler/scheduled?time=${Date.now()}&cron=*+*+*+*+*`,
    )
  expect((await tick()).status).toBe(200)
  expect((await tick()).status).toBe(200)
  expect(
    (
      await d1
        .prepare('SELECT job_id,occurrence_key,state,confirmed_by_user_id FROM proposed_runs')
        .all()
    ).results,
  ).toEqual([{ job_id: 1, occurrence_key: period, state: 'proposed', confirmed_by_user_id: null }])
  expect(
    (await d1.prepare('SELECT subject_id,target,state,attempt_count FROM run_items').all()).results,
  ).toEqual([{ subject_id: 1, target: 'a@example.test', state: 'pending', attempt_count: 0 }])
  expect((await d1.prepare('SELECT count(*) AS count FROM email_log').first())?.count).toBe(0)
})
