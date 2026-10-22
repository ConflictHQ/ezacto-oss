import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { createD1Database, migrateD1, createD1SessionStore } from '@ezacto/db/d1'
import { createQueuedMigrationStore } from '@ezacto/db/queued-migrations'
import { cloudflareMigrationOperator } from '../src/cloudflare-operator.js'
import { startQueuedSnapshot, uploadQueuedSnapshot } from '../src/queued-upload.js'
import { assertLoadComplete } from '../src/load-engine.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'
import { sha256Hex } from '../src/portable-hash.js'

it('[e2e #409] uploads only verified source, resumes interrupted transfer, and completes through real native Queue deliveries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezacto-queued-upload-'))
  let mf: Miniflare | undefined
  try {
    const snapshotDir = join(dir, 'snapshot'),
      fixture = await buildSanitizedLoadSnapshot(snapshotDir)
    await writeFile(join(snapshotDir, '.dev.vars'), 'NEVER_UPLOAD_THIS=private-fixture-value')
    const code = await build({
      stdin: {
        contents: `
      import {consumeMigrationBatch} from '../../entries/worker/src/migration-queue.ts'
      import {worker} from '../../entries/worker/src/index.ts'
      export default {async fetch(request,env,ctx){if(new URL(request.url).pathname!=='/send')return worker.fetch(request,env,ctx);await env.MIGRATION_QUEUE.send(await request.json());return new Response(null,{status:202})},
        async queue(batch,env){await consumeMigrationBatch(batch,env)}}`,
        resolveDir: new URL('../', import.meta.url).pathname,
      },
      bundle: true,
      conditions: ['development'],
      platform: 'browser',
      external: ['node:async_hooks'],
      format: 'esm',
      target: 'es2022',
      write: false,
    })
    mf = new Miniflare({
      modules: true,
      script: code.outputFiles[0]!.text,
      compatibilityDate: '2026-08-06',
      compatibilityFlags: ['nodejs_als'],
      bindings: {
        API_CURSOR_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        ENVIRONMENT: 'test',
        RELEASE: 'queued-upload-fixture',
      },
      d1Databases: ['DB'],
      r2Buckets: ['ATTACHMENTS'],
      queueProducers: { MIGRATION_QUEUE: 'fixture-load' },
      queueConsumers: {
        'fixture-load': {
          maxBatchSize: 1,
          maxBatchTimeout: 0,
          maxRetries: 5,
          retryDelay: 0,
          deadLetterQueue: 'fixture-load-dlq',
        },
      },
    })
    const db = await mf.getD1Database('DB'),
      bucket = await mf.getR2Bucket('ATTACHMENTS')
    await migrateD1(db)
    const target = {
      accountId: 'a'.repeat(32),
      apiToken: 'private-test-operator-token',
      databaseId: '00000000-0000-4000-8000-000000000002',
      bucket: 'fixture-attachments',
      queueId: 'b'.repeat(32),
    }
    let puts = 0,
      failUpload = true,
      queuePosts = 0
    const keys: string[] = []
    const fetcher = (async (input, init) => {
      const url = new URL(String(input)),
        headers = new Headers(init?.headers)
      expect(url.origin).toBe('https://api.cloudflare.com')
      expect(headers.get('authorization')).toBe('Bearer ' + target.apiToken)
      expect(init?.redirect).toBe('error')
      if (url.pathname.endsWith('/query')) {
        const { batch } = JSON.parse(String(init?.body)) as {
          batch: { sql: string; params: unknown[] }[]
        }
        try {
          return Response.json({
            success: true,
            result: await db.batch(
              batch.map((statement) => db.prepare(statement.sql).bind(...statement.params)),
            ),
          })
        } catch {
          return Response.json({ success: false, result: [] }, { status: 400 })
        }
      }
      if (url.pathname.endsWith('/messages')) {
        queuePosts++
        const { body } = JSON.parse(String(init?.body)) as { body: unknown }
        expect(Object.keys(body as object).sort()).toEqual(['kind', 'runId', 'sequence'])
        await mf!.dispatchFetch('https://fixture.test/send', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        return Response.json({ success: true, result: {} })
      }
      const marker = '/objects/',
        position = url.pathname.indexOf(marker)
      expect(position).toBeGreaterThan(0)
      const key = decodeURIComponent(url.pathname.slice(position + marker.length))
      expect(url.pathname).not.toContain('%2F')
      keys.push(key)
      if (init?.method === 'PUT') {
        puts++
        if (failUpload && puts === 5)
          return new Response('private provider diagnostic', { status: 503 })
        expect(headers.get('if-none-match')).toBe('*')
        const bytes = await new Response(init.body).arrayBuffer(),
          object = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' } })
        if (!object) return new Response(null, { status: 412 })
        return Response.json({
          success: true,
          result: { key, etag: object.etag, size: String(object.size) },
        })
      }
      const object = await bucket.get(key)
      if (!object) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(await object.arrayBuffer()), {
        headers: { etag: `"${object.etag}"`, 'content-length': String(object.size) },
      })
    }) as typeof fetch
    const operator = cloudflareMigrationOperator(target, fetcher),
      runId = crypto.randomUUID(),
      store = createQueuedMigrationStore(db)
    await expect(uploadQueuedSnapshot({ snapshotDir, runId }, operator)).rejects.toThrow(
      'could not be verified',
    )
    expect(await store.status(runId)).toBeNull()
    expect(queuePosts).toBe(0)
    failUpload = false
    const ready = await uploadQueuedSnapshot({ snapshotDir, runId }, operator)
    expect(ready.status).toBe('ready')
    expect(queuePosts).toBe(0)
    expect(
      keys.some(
        (key) =>
          key.includes('auth.json') || key.includes('.dev.vars') || key.includes('.sync.lock'),
      ),
    ).toBe(false)
    const files = (await store.job(runId))!.catalog.files
    expect(puts).toBe(files.length + 1) // Four successful objects were reused; the fifth failed once.
    await expect(
      startQueuedSnapshot(
        { runId, confirmDatabaseId: '00000000-0000-4000-8000-000000000003' },
        operator,
      ),
    ).rejects.toThrow()
    expect(queuePosts).toBe(0)
    await startQueuedSnapshot({ runId, confirmDatabaseId: target.databaseId }, operator)
    await expect
      .poll(async () => (await store.status(runId))?.status, { timeout: 60000 })
      .toBe('completed')
    await assertLoadComplete(createD1Database(db), ready.snapshotSha256)
    const counts = await db
      .prepare(
        'SELECT count(*) AS total,count(DISTINCT harvest_id) AS distinct_rows FROM time_entries',
      )
      .first<{ total: number; distinct_rows: number }>()
    expect(counts!.total).toBeGreaterThan(0)
    expect(counts!.total).toBe(counts!.distinct_rows)
    // Completion removes confidential raw inputs and rebuildable caches, while attachment bytes survive.
    await expect
      .poll(async () => bucket.head(`migrate/${runId}/input/raw/time_entries.jsonl`), {
        timeout: 5000,
      })
      .toBeNull()
    await expect
      .poll(async () => (await store.status(runId))?.sourceCleanedAt, { timeout: 5000 })
      .not.toBeNull()
    const admin = await db
      .prepare("SELECT id FROM users WHERE profile='administrator' ORDER BY id LIMIT 1")
      .first<{ id: number }>()
    const session = await createD1SessionStore(db).issue(admin!.id)
    const statusResponse = await mf.dispatchFetch(
      'https://fixture.test/api/v1/migration-loads/' + runId,
      { headers: { cookie: '__Host-ezacto_session=' + session.token } },
    )
    expect(statusResponse.status, await statusResponse.clone().text()).toBe(200)
    const safeStatus = await statusResponse.text()
    expect(JSON.parse(safeStatus).data).toMatchObject({
      id: runId,
      status: 'completed',
      error_code: null,
    })
    for (const secret of ['catalog', 'options', 'private-test-operator-token', 'NEVER_UPLOAD_THIS'])
      expect(safeStatus).not.toContain(secret)
    const receipt = await bucket.get(`migrate/${runId}/input/${fixture.receipt.path}`)
    expect(sha256Hex(new Uint8Array(await receipt!.arrayBuffer()))).toBe(fixture.receipt.sha256)
  } finally {
    await mf?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}, 120000)
