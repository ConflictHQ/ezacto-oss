import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { migrateD1, createD1SessionStore } from '@ezacto/db'
import { createWorkerCsvStaging } from '../src/csv-staging.js'
import { createWorkerCsvApply } from '../src/csv-apply.js'
import { sha256Hex } from '../../../packages/migrate/src/portable-hash.js'
const fixtures: Miniflare[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
const firstBytes = new TextEncoder().encode(
  'Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\nowned@example.test,C,P,T,Owned private note,Yes,2026-09-01,09:00:00,2026-09-01,10:00:00,01:00:00\n',
)
const text = new TextDecoder().decode(firstBytes)
const bytes = new TextEncoder().encode(
  text + text.trimEnd().split('\n')[1]!.replaceAll('2026-09-01', '2026-09-02') + '\n',
)
const chunks = async function* () {
  yield bytes
}
const fixture = async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
    r2Buckets: ['PRIVATE'],
  })
  fixtures.push(mf)
  const db = await mf.getD1Database('DB'),
    bucket = await mf.getR2Bucket('PRIVATE')
  await migrateD1(db)
  const now = new Date().toISOString()
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned Worker','{}',?,?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Owned','Admin','administrator','[]',?,?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(2,'owned@example.test',1,?,?,?)",
      )
      .bind(now, now, now),
    db
      .prepare(
        "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'C','USD',?,?)",
      )
      .bind(now, now),
    db
      .prepare("INSERT INTO projects(id,name,client_id,created_at,updated_at) VALUES(1,'P',1,?,?)")
      .bind(now, now),
    db.prepare("INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'T',?,?)").bind(now, now),
    db
      .prepare(
        'INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(1,2,?,?)',
      )
      .bind(now, now),
    db
      .prepare(
        'INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,?,?)',
      )
      .bind(now, now),
  ])
  const session = await createD1SessionStore(db).issue(2),
    authority = { userId: 2, sessionRowId: session.session.id }
  let failDelete = false,
    afterGet: (() => Promise<void>) | null = null
  const wrapped = new Proxy(bucket, {
    get(target, key) {
      if (key === 'delete')
        return async (...args: Parameters<R2Bucket['delete']>) => {
          if (failDelete) throw new Error('owned deletion failure')
          return target.delete(...args)
        }
      if (key === 'get')
        return async (...args: [string]) => {
          const value = await target.get(...args)
          await afterGet?.()
          return value
        }
      const v = Reflect.get(target, key, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as unknown as R2Bucket
  const stats: { calls: number; phase: 'seal' | 'row' }[] = []
  const staging = createWorkerCsvStaging(db, wrapped, new Uint8Array(32).fill(3))
  const upload = () =>
    staging.port.upload(
      authority,
      chunks(),
      { sha256: sha256Hex(bytes), bytes: bytes.length },
      new AbortController().signal,
    )
  const map = async () => {
    const run = await upload()
    return staging.port.map(authority, run.id, {
      version: run.version,
      workspace_identity: 'owned-worker',
      exporter_zone: 'UTC',
      date_format: 'iso',
      destination_interpretation: 'source_wall_time',
      currency_policy: 'destination_rates',
      mapping: {},
      excluded_lines: [],
    })
  }
  const business = async () =>
    JSON.stringify(
      (
        await db.batch(
          [
            'users',
            'user_emails',
            'clients',
            'projects',
            'tasks',
            'user_assignments',
            'task_assignments',
            'time_entries',
          ].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`)),
        )
      ).map((result) => result.results),
    )
  return {
    db,
    bucket,
    staging,
    authority,
    map,
    business,
    stats,
    apply: createWorkerCsvApply(db, wrapped, new Uint8Array(32).fill(3), {
      onInvocation: (value) => stats.push(value),
    }),
    setFailDelete: (value: boolean) => {
      failDelete = value
    },
    setAfterGet: (value: () => Promise<void>) => {
      afterGet = value
    },
  }
}

const prepare = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const run = await f.map(),
    preview = await f.staging.port.preview(
      f.authority,
      run.id,
      undefined,
      new AbortController().signal,
    )
  const command = {
    command_id: crypto.randomUUID(),
    preview_id: preview.preview_id,
    version: preview.run.version,
    expected_selected_rows: preview.tallies.selected_rows,
    expected_source_seconds: preview.tallies.source_seconds,
    expected_destination_seconds: preview.tallies.destination_seconds,
    acknowledge_exclusions: false,
    acknowledge_destination_difference: true,
    acknowledge_new_people: true,
  }
  await f.apply.port.apply(f.authority, run.id, command)
  return { run, preview, command }
}

it('requires fresh review after a revision pause and resumes only the remaining committed selection', async () => {
  const f = await fixture(),
    input = await prepare(f)
  await f.apply.execute(input.run.id)
  await f.apply.execute(input.run.id)
  expect(await f.db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({ n: 1 })
  await f.db.prepare("UPDATE organizations SET currency='EUR' WHERE id=1").run()
  await f.apply.execute(input.run.id)
  expect(await f.apply.port.status(f.authority, input.run.id)).toMatchObject({
    state: 'paused',
    code: 'policy_changed',
    committed_rows: 1,
  })
  const paused = await f.staging.port.read(f.authority, input.run.id)
  const choices = {
    version: paused.version,
    workspace_identity: 'owned-worker',
    exporter_zone: 'UTC',
    date_format: 'iso' as const,
    destination_interpretation: 'source_wall_time' as const,
    currency_policy: 'destination_rates' as const,
    mapping: {},
    excluded_lines: [],
  }
  await f.staging.port.map(f.authority, input.run.id, choices)
  await expect(
    f.staging.port.preview(f.authority, input.run.id, undefined, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'worker_policy_changed' })
  await f.db.prepare("UPDATE organizations SET currency='USD' WHERE id=1").run()
  const current = await f.staging.port.read(f.authority, input.run.id)
  await f.staging.port.map(f.authority, input.run.id, { ...choices, version: current.version })
  const preview = await f.staging.port.preview(
    f.authority,
    input.run.id,
    undefined,
    new AbortController().signal,
  )
  const command = {
    ...input.command,
    command_id: crypto.randomUUID(),
    preview_id: preview.preview_id,
    version: preview.run.version,
    expected_selected_rows: preview.tallies.selected_rows,
    expected_source_seconds: preview.tallies.source_seconds,
    expected_destination_seconds: preview.tallies.destination_seconds,
  }
  await f.apply.port.resume(f.authority, input.run.id, command)
  for (let i = 0; i < 5; i++) {
    await f.apply.execute(input.run.id)
    if ((await f.apply.port.status(f.authority, input.run.id)).state === 'completed') break
  }
  expect(
    await f.apply.port.status(f.authority, input.run.id),
    JSON.stringify({
      stage: await f.db
        .prepare('SELECT status,safe_code,revision,native_run_id FROM csv_worker_stages WHERE id=?')
        .bind(input.run.id)
        .first(),
      native: await f.db
        .prepare('SELECT browser_state,committed_chunks FROM csv_import_runs')
        .all(),
    }),
  ).toMatchObject({
    state: 'completed',
    committed_rows: 2,
    source_seconds_committed: 7200,
    destination_seconds: 7200,
  })
  expect(
    await f.db
      .prepare('SELECT count(*) AS n,sum(rounded_seconds) AS seconds FROM time_entries')
      .first(),
  ).toEqual({ n: 2, seconds: 7200 })
}, 60000)
it('repairs a completed native run after a lost stage settlement even if policy revision changed, then purges only input', async () => {
  const f = await fixture(),
    input = await prepare(f)
  for (let i = 0; i < 5; i++) {
    await f.apply.execute(input.run.id)
    if ((await f.apply.port.status(f.authority, input.run.id)).state === 'completed') break
  }
  expect(await f.db.prepare('SELECT browser_state FROM csv_import_runs').first()).toEqual({
    browser_state: 'complete',
  })
  await f.db
    .prepare(
      "UPDATE csv_worker_stages SET status='running',lease_holder='lost-settlement',lease_expires_at='2020-01-01T00:00:00Z',finished_at=NULL,publish_pending=1,version=version+1 WHERE id=?",
    )
    .bind(input.run.id)
    .run()
  await f.db.prepare("UPDATE organizations SET currency='EUR' WHERE id=1").run()
  await f.apply.execute(input.run.id)
  expect(
    await f.db
      .prepare('SELECT status,publish_pending FROM csv_worker_stages WHERE id=?')
      .bind(input.run.id)
      .first(),
  ).toEqual({ status: 'completed', publish_pending: 0 })
  await f.staging.port.purge(f.authority, input.run.id)
  expect((await f.bucket.list()).objects).toEqual([])
  expect(
    await f.db
      .prepare('SELECT count(*) AS n,sum(rounded_seconds) AS seconds FROM time_entries')
      .first(),
  ).toEqual({ n: 2, seconds: 7200 })
}, 60000)
it('refuses an oversized native seal before any run or time is created', async () => {
  const f = await fixture(),
    run = await f.map()
  const preview = await f.staging.port.preview(
    f.authority,
    run.id,
    undefined,
    new AbortController().signal,
  )
  const row = await f.staging.read(run.id)
  const input = await f.staging.saved(f.authority, row!, preview.preview_id)
  const { createD1CsvBrowserService, D1_CSV_MAX_SEAL_BYTES } =
    await import('../../../packages/migrate/src/csv-browser-d1.js')
  const service = await createD1CsvBrowserService(f.db, {
    stageId: run.id,
    targetNonce: row!.target_nonce,
    authority: f.authority,
    generation: row!.lease_generation,
    holder: 'owned-size-refusal',
  })
  expect(() =>
    service.confirm(
      { kind: 'administrator', userId: String(f.authority.userId) },
      { ...input.plan, destinationFacts: 'x'.repeat(D1_CSV_MAX_SEAL_BYTES + 1) },
    ),
  ).toThrow('snapshot_budget_exceeded')
  expect(await f.db.prepare('SELECT count(*) AS n FROM csv_import_runs').first()).toEqual({ n: 0 })
  expect(await f.db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({ n: 0 })
}, 60000)
