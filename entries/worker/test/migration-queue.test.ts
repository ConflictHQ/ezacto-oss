import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { migrateD1 } from '@ezacto/db/d1'
import { createQueuedMigrationStore } from '@ezacto/db/queued-migrations'

it('[e2e #409] routes imports without email credentials, quarantines a newly reserved target, and dead-letters poison', async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import {worker} from './src/index.ts'
    export default {
      async fetch(request,env,ctx){
        if(new URL(request.url).pathname==='/fixture/send'){
          await env.MIGRATION_QUEUE.send(await request.json());return new Response(null,{status:202})
        }
        return worker.fetch(request,env,ctx)
      },
      async queue(batch,env,ctx){
        if(batch.queue==='fixture-migration-dlq'){
          for(const message of batch.messages){
            await env.DB.prepare("INSERT INTO fixture_queue_events(kind,attempt) VALUES('dead_letter',?)").bind(message.attempts).run()
            message.ack()
          }
          return
        }
        const delays=[]
        // Exercise the production consumer; accelerate only the fixture's local transport clock.
        const messages=batch.messages.map(message=>({body:message.body,id:message.id,timestamp:message.timestamp,attempts:message.attempts,
          ack:()=>message.ack(),retry:options=>{delays.push(options.delaySeconds);message.retry({delaySeconds:0})}}))
        await worker.queue({...batch,queue:batch.queue,messages},env,ctx)
        for(const delay of delays)await env.DB.prepare("INSERT INTO fixture_queue_events(kind,attempt) VALUES('retry_delay',?)").bind(delay).run()
      }
    }`,
      resolveDir: new URL('../', import.meta.url).pathname,
    },
    bundle: true,
    platform: 'browser',
    conditions: ['development'],
    external: ['node:async_hooks'],
    format: 'esm',
    target: 'es2022',
    write: false,
  })
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
    bindings: {
      API_CURSOR_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ENVIRONMENT: 'test',
      MIGRATION_QUEUE_NAME: 'fixture-migration',
    },
    queueProducers: { MIGRATION_QUEUE: 'fixture-migration' },
    queueConsumers: {
      'fixture-migration': {
        maxBatchSize: 1,
        maxBatchTimeout: 0,
        maxRetries: 5,
        retryDelay: 0,
        deadLetterQueue: 'fixture-migration-dlq',
      },
      'fixture-migration-dlq': { maxBatchSize: 1, maxBatchTimeout: 0 },
    },
  })
  try {
    const db = await mf.getD1Database('DB')
    await migrateD1(db)
    await db.exec(
      'CREATE TABLE fixture_queue_events(kind TEXT NOT NULL,attempt INTEGER NOT NULL) STRICT',
    )
    // Warm the isolate before reserving a target: a cached readiness check must not bypass quarantine.
    expect((await mf.dispatchFetch('https://worker.test/api/v1/time-entries')).status).toBe(401)
    const id = crypto.randomUUID(),
      store = createQueuedMigrationStore(db),
      now = new Date().toISOString()
    await store.create(
      {
        version: 1,
        jobId: id,
        snapshotSha256: '1'.repeat(64),
        manifestSha256: '2'.repeat(64),
        checksumsSha256: '3'.repeat(64),
        sourceFingerprint: '4'.repeat(64),
        sourceRows: 0,
        indexBytes: 0,
        files: [
          { path: 'manifest.json', bytes: 2, sha256: '2'.repeat(64), etag: 'm' },
          { path: 'checksums.json', bytes: 2, sha256: '3'.repeat(64), etag: 'c' },
        ],
      },
      {},
      now,
    )
    const blocked = await mf.dispatchFetch('https://worker.test/api/v1/time-entries')
    expect(blocked.status).toBe(503)
    expect(await blocked.text()).not.toContain(id)
    expect((await mf.dispatchFetch('https://worker.test/healthz')).status).toBe(200)
    await mf.dispatchFetch('https://worker.test/fixture/send', {
      method: 'POST',
      body: JSON.stringify({ kind: 'invalid-poison' }),
    })
    await expect
      .poll(
        async () =>
          db
            .prepare("SELECT count(*) AS n FROM fixture_queue_events WHERE kind='dead_letter'")
            .first('n'),
        { timeout: 15000 },
      )
      .toBe(1)
    const delays = await db
      .prepare("SELECT attempt FROM fixture_queue_events WHERE kind='retry_delay'")
      .all<{ attempt: number }>()
    expect(delays.results.length).toBeGreaterThan(0)
    expect(delays.results.every((row) => row.attempt === 60)).toBe(true)
    await store.cancel(id, now)
    expect((await mf.dispatchFetch('https://worker.test/api/v1/time-entries')).status).toBe(401)
  } finally {
    await mf.dispose()
  }
}, 60000)
