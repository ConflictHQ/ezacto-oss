import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { scheduledJobConfig } from '@ezacto/core'
import { createD1Database } from '../../../packages/db/src/adapters.js'
import { createD1EmailConfigurationStore } from '../../../packages/db/src/email-configuration.js'
import {
  createScheduledJobsService,
  proposeDueScheduledJobs,
} from '../../../packages/db/src/scheduled-jobs.js'
import { createScheduledRunsService } from '../../../packages/db/src/scheduled-runs.js'
import { seedMonthEndJobFixture } from '../../../packages/db/test/support/month-end-job-fixture.js'
import { scheduledRunWorkflowId } from '../src/scheduled-run-workflow-scheduler.js'
let worker: Miniflare | undefined
afterEach(async () => worker?.dispose())
it('[native #62] resumes a terminated partial Workflow without repeating the completed item', async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/workflow-main.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    external: ['node:async_hooks', 'cloudflare:workers'],
    target: 'es2022',
    write: false,
  })
  worker = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE',
      ENVIRONMENT: 'test',
      RELEASE: 'workflow-test',
      AWS_ACCESS_KEY_ID: 'native-workflow-fixture',
      AWS_SECRET_ACCESS_KEY: 'native-workflow-fixture-secret',
      SES_REGION: 'us-west-2',
      SES_FROM: 'billing@example.test',
    },
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
    queueProducers: { EMAIL_QUEUE: 'native-workflow-mail' },
    workflows: {
      SCHEDULED_RUN_WORKFLOW: { name: 'native-scheduled-run', className: 'ScheduledRunWorkflow' },
    },
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  })
  await worker.dispatchFetch('https://worker.test/api/v1')
  const d1 = await worker.getD1Database('DB'),
    database = createD1Database(d1),
    objects = await worker.getR2Bucket('ATTACHMENTS'),
    now = new Date(),
    stamp = now.toISOString(),
    period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
      .toISOString()
      .slice(0, 7)
  await seedMonthEndJobFixture(database, period, stamp)
  await d1
    .prepare('INSERT INTO report_brands(id,name,created_at,updated_at) VALUES(1,?,?,?),(2,?,?,?)')
    .bind('Native Brand A', stamp, stamp, 'Native Brand B', stamp, stamp)
    .run()
  await d1.prepare('UPDATE clients SET report_brand_id=id WHERE id IN(1,2)').run()
  const configuration = createD1EmailConfigurationStore(d1)
  await configuration.createSenderIdentity({
    id: 10,
    email: 'billing@example.test',
    displayName: 'Billing',
    provider: 'ses',
    providerIdentity: 'example.test',
    actorUserId: 1,
    commandId: 'native-sender',
    occurredAt: stamp,
  })
  await configuration.recordSenderEvidence({
    id: 10,
    expectedEvidenceVersion: 0,
    evidence: {
      source: 'provider_api',
      identityKind: 'domain',
      verificationStatus: 'verified',
      dkimStatus: 'verified',
      mailFromDomain: 'bounce.example.test',
      mailFromStatus: 'verified',
      observedAt: stamp,
    },
    actorUserId: 1,
    commandId: 'native-evidence',
    occurredAt: stamp,
  })
  await configuration.setDefaultSenderIdentity({
    id: 10,
    expectedVersion: 0,
    actorUserId: 1,
    commandId: 'native-default',
    occurredAt: stamp,
  })
  await createScheduledJobsService(database).create(
    1,
    scheduledJobConfig({ name: 'Native Workflow' }),
    stamp,
  )
  await proposeDueScheduledJobs(database, stamp, {
    put: async (key, bytes) => {
      await objects.put(key, bytes)
    },
  })
  const tick = () =>
    worker!.dispatchFetch(
      `https://worker.test/cdn-cgi/handler/scheduled?time=${Date.now()}&cron=*+*+*+*+*`,
    )
  // A proposal cannot cause either a Workflow or a client delivery.
  await tick()
  expect(
    (await d1.prepare('SELECT count(*) AS count FROM scheduled_run_deliveries').first())?.count,
  ).toBe(0)
  const missing = await d1
    .prepare('SELECT report_file_key AS key FROM run_items ORDER BY id LIMIT 1')
    .first<{ key: string }>()
  const saved = await (await objects.get(missing!.key))!.arrayBuffer()
  await objects.delete(missing!.key)
  await createScheduledRunsService(database).confirm(1, 1, new Date().toISOString())
  expect((await tick()).status).toBe(200)
  const bindings = await worker.getBindings<{ SCHEDULED_RUN_WORKFLOW: Workflow }>()
  const instance = await bindings.SCHEDULED_RUN_WORKFLOW.get(
    await scheduledRunWorkflowId({ id: 1, proposed_at: stamp, generation: 6 }),
  )
  await expect
    .poll(async () => (await d1.prepare('SELECT state FROM run_items ORDER BY id').all()).results, {
      timeout: 15000,
      interval: 50,
    })
    .toEqual([{ state: 'failed' }, { state: 'done' }])
  expect(['running', 'waiting']).toContain((await instance.status()).status)
  const completedReceipt = await d1
    .prepare('SELECT delivery_id FROM scheduled_run_deliveries')
    .first()
  await instance.terminate()
  await objects.put(missing!.key, saved)
  // Cron respects termination even though the failed item is eligible.
  await tick()
  expect((await instance.status()).status).toBe('terminated')
  expect(
    (await d1.prepare('SELECT attempt_count FROM run_items ORDER BY id').all()).results,
  ).toEqual([{ attempt_count: 1 }, { attempt_count: 1 }])
  await instance.restart()
  await expect
    .poll(
      async () => (await d1.prepare('SELECT state FROM proposed_runs WHERE id=1').first())?.state,
      { timeout: 15000, interval: 50 },
    )
    .toBe('completed')
  expect(
    await d1
      .prepare(
        'SELECT delivery_id FROM scheduled_run_deliveries WHERE run_item_id=(SELECT MAX(id) FROM run_items)',
      )
      .first(),
  ).toEqual(completedReceipt)
  const receipts = (
    await d1
      .prepare(
        'SELECT run_item_id,delivery_id,attachment_id FROM scheduled_run_deliveries ORDER BY run_item_id',
      )
      .all()
  ).results
  expect(receipts).toHaveLength(2)
  expect(
    (await d1.prepare('SELECT attempt_count FROM run_items ORDER BY id').all()).results,
  ).toEqual([{ attempt_count: 2 }, { attempt_count: 1 }])
  await expect
    .poll(async () => (await instance.status()).status, { timeout: 5000, interval: 50 })
    .toBe('complete')
  await instance.restart()
  await expect
    .poll(async () => (await instance.status()).status, { timeout: 10000, interval: 50 })
    .toBe('complete')
  await tick()
  expect(
    (
      await d1
        .prepare(
          'SELECT run_item_id,delivery_id,attachment_id FROM scheduled_run_deliveries ORDER BY run_item_id',
        )
        .all()
    ).results,
  ).toEqual(receipts)
  expect(
    (await d1.prepare('SELECT attempt_count FROM run_items ORDER BY id').all()).results,
  ).toEqual([{ attempt_count: 2 }, { attempt_count: 1 }])
}, 30000)
