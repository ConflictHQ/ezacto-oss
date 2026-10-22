import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { createD1Database, migrateD1 } from '@ezacto/db/d1'
import { createQueuedMigrationStore } from '@ezacto/db/queued-migrations'
import {
  parseMigrationSnapshotCatalog,
  migrationInputPrefix,
  type MigrationSnapshotFile,
} from '@ezacto/core'
import { childIndexBytesNeeded, assertLoadComplete } from '../src/load-engine.js'
import { sourceFingerprint } from '../src/load-lease.js'
import { sha256Hex } from '../src/portable-hash.js'
import { declaredSnapshotBinaries } from '../src/queued-snapshot.js'
import { r2SnapshotSource, type SnapshotBucket } from '../src/r2-snapshot-source.js'
import { RESOURCES } from '../src/resources.js'
import { readManifest } from '../src/manifest.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'

it.each(['lease-crash', 'queue-publication'] as const)(
  '[e2e #409] resumes a full R2 snapshot after %s across fresh Worker isolates',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'ezacto-queued-worker-'))
    let mf: Miniflare | undefined
    try {
      const snapshotDir = join(directory, 'snapshot'),
        fixture = await buildSanitizedLoadSnapshot(snapshotDir)
      const code = await build({
        stdin: {
          contents:
            mode === 'queue-publication'
              ? `
      import {createQueuedMigrationStore} from '@ezacto/db/queued-migrations'
      import {deliverQueuedLoad} from './src/queued-loader.js'
      export default {async fetch(request,env){
        const input=await request.json(),store=createQueuedMigrationStore(env.DB),emitted=[]
        const message=input.message??await store.pending(input.catalog.jobId)
        const result=await deliverQueuedLoad({...env,MIGRATION_QUEUE:{async send(message){
          if(input.crash)throw new Error('Fixture transport unavailable after checkpoint')
          emitted.push(message)
        }}},message,1,{now:()=>input.now,maxRows:1,maxStatements:100})
        const job=await store.status(input.catalog.jobId)
        return Response.json({...result,complete:job.status==='completed',emitted},{status:'ack' in result?200:503})
      }}
    `
              : `
      import {createD1Database} from '@ezacto/db/d1'
      import {claimLoadLease,loadNextChunk,releaseLoadLease} from './src/load-engine.js'
      import {openQueuedSnapshot} from './src/queued-snapshot.js'
      import {r2ChildIndexStore} from './src/r2-child-index-store.js'
      export default { async fetch(request,env) {
        const input=await request.json()
        const snapshot=await openQueuedSnapshot(env.ATTACHMENTS,input.catalog)
        const database=createD1Database(env.DB)
        const lease=await claimLoadLease({database,source:snapshot.source,artifacts:snapshot.artifacts,ttlMs:1000,now:()=>input.now})
        const result=await loadNextChunk({database,source:snapshot.source,artifacts:snapshot.artifacts,
          indexStore:r2ChildIndexStore(env.ATTACHMENTS,'migrate/'+snapshot.catalog.jobId+'/index'),
          lease,immutableSnapshotSha256:snapshot.catalog.snapshotSha256,maxRows:1,maxStatements:100})
        // Test-only process-death seam: a real crash cannot execute finally/release.
        if(input.crash&&result.resource==='time_entries'&&result.loadedRows>0)return new Response('forced fixture crash',{status:503})
        await releaseLoadLease(database,lease)
        return Response.json(result)
      }}
    `,
          resolveDir: new URL('../', import.meta.url).pathname,
          sourcefile: 'queued-worker-fixture.ts',
        },
        bundle: true,
        conditions: ['development'],
        platform: 'browser',
        external: ['node:async_hooks'],
        format: 'esm',
        target: 'es2022',
        write: false,
      })
      const options = {
        modules: true as const,
        script: code.outputFiles[0]!.text,
        compatibilityDate: '2026-08-06',
        compatibilityFlags: ['nodejs_als'],
        d1Databases: ['DB'],
        r2Buckets: ['ATTACHMENTS'],
        d1Persist: join(directory, 'd1'),
        r2Persist: join(directory, 'r2'),
      }
      mf = new Miniflare(options)
      await migrateD1(await mf.getD1Database('DB'))
      const bucket = await mf.getR2Bucket('ATTACHMENTS'),
        jobId = crypto.randomUUID(),
        prefix = migrationInputPrefix(jobId)
      const manifest = await readManifest(snapshotDir),
        paths = new Set(['manifest.json', 'checksums.json'])
      for (const name of Object.keys(manifest.resources)) {
        paths.add(`raw/${name}.jsonl`)
        if (RESOURCES.find((step) => step.name === name)?.kind === 'child')
          paths.add(`raw/${name}.lineage.jsonl`)
      }
      for (const binary of declaredSnapshotBinaries(manifest)) paths.add(binary.path)
      const files: MigrationSnapshotFile[] = []
      for (const path of paths) {
        const bytes = await readFile(join(snapshotDir, path)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path.startsWith('raw/'))
            return Buffer.alloc(0)
          throw error
        })
        const object = await bucket.put(prefix + path, new Uint8Array(bytes).buffer, {
          sha256: sha256Hex(bytes),
        })
        if (!object) throw new Error('Fixture upload was refused')
        files.push({
          path,
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          etag: object.etag,
          ...(path.startsWith('raw/')
            ? {
                maxLineBytes: Math.max(
                  ...bytes
                    .toString('utf8')
                    .split('\n')
                    .map((line: string) => Buffer.byteLength(line)),
                ),
              }
            : {}),
        })
      }
      const checksums = JSON.parse(await readFile(join(snapshotDir, 'checksums.json'), 'utf8')) as {
        snapshot_sha256: string
      }
      const catalog = parseMigrationSnapshotCatalog({
        version: 1,
        jobId,
        snapshotSha256: checksums.snapshot_sha256,
        manifestSha256: files.find((file) => file.path === 'manifest.json')!.sha256,
        checksumsSha256: files.find((file) => file.path === 'checksums.json')!.sha256,
        sourceFingerprint: await sourceFingerprint(
          r2SnapshotSource(bucket as unknown as SnapshotBucket, prefix),
          manifest,
        ),
        sourceRows: Object.values(manifest.resources).reduce(
          (sum, resource) => sum + resource.count,
          0,
        ),
        indexBytes: childIndexBytesNeeded(manifest),
        files,
      })
      if (mode === 'queue-publication') {
        const store = createQueuedMigrationStore(await mf.getD1Database('DB'))
        await store.create(catalog, {}, '2026-10-22T09:00:00.000Z')
        await store.start(jobId, '2026-10-22T09:00:00.000Z')
      }
      let clock = Date.parse('2026-10-22T09:00:00.000Z')
      let crashed = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const response = await mf.dispatchFetch('https://fixture.test/chunk', {
          method: 'POST',
          body: JSON.stringify({ catalog, now: clock, crash: true }),
        })
        if (response.status === 503) {
          crashed = true
          break
        }
        expect(response.status, await response.clone().text()).toBe(200)
        clock += 1
      }
      expect(crashed).toBe(true)
      const checkpointKey = `migrate/${jobId}/index/checkpoint.json`
      const checkpointBeforeRestart = (await bucket.head(checkpointKey))?.etag
      if (mode === 'lease-crash') expect(checkpointBeforeRestart).toBeTypeOf('string')
      await mf.dispose()
      mf = new Miniflare(options)
      expect((await (await mf.getR2Bucket('ATTACHMENTS')).head(checkpointKey))?.etag).toBe(
        checkpointBeforeRestart,
      )
      if (mode === 'queue-publication') {
        const duplicate = await mf.dispatchFetch('https://fixture.test/chunk', {
          method: 'POST',
          body: JSON.stringify({
            catalog,
            now: clock,
            message: { kind: 'migration-load-v1', runId: jobId, sequence: 0 },
          }),
        })
        expect(duplicate.status, await duplicate.clone().text()).toBe(200)
        expect(((await duplicate.json()) as { emitted: unknown[] }).emitted).toEqual([
          { kind: 'migration-load-v1', runId: jobId, sequence: 1 },
        ])
      }
      clock += 1001 // A replacement process may take over the abandoned lease, not use its holder.
      let complete = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const response = await mf.dispatchFetch('https://fixture.test/chunk', {
          method: 'POST',
          body: JSON.stringify({ catalog, now: clock }),
        })
        expect(response.status, await response.clone().text()).toBe(200)
        const result = (await response.json()) as { complete: boolean }
        if (result.complete) {
          complete = true
          break
        }
        clock += 1
      }
      expect(complete).toBe(true)
      const database = await mf.getD1Database('DB')
      await assertLoadComplete(createD1Database(database), catalog.snapshotSha256)
      const count = await database
        .prepare(
          'SELECT count(*) AS total,count(DISTINCT harvest_id) AS unique_rows FROM time_entries',
        )
        .first<{ total: number; unique_rows: number }>()
      expect(count!.total).toBeGreaterThan(0)
      expect(count!.total).toBe(count!.unique_rows)
      const leaseLog = await database
        .prepare("SELECT count(*) AS total FROM _ezacto_load_lease_log WHERE event='taken_over'")
        .first<{ total: number }>()
      expect(leaseLog!.total).toBe(mode === 'lease-crash' ? 1 : 0)
      if (mode === 'queue-publication')
        expect(await createQueuedMigrationStore(database).status(jobId)).toMatchObject({
          status: 'completed',
          errorCode: null,
        })
      const file = await database
        .prepare('SELECT file_key FROM file_objects WHERE content_hash=?')
        .bind(fixture.receipt.sha256)
        .first<{ file_key: string }>()
      expect(file?.file_key).toBe(prefix + fixture.receipt.path)
      const stored = await (await mf.getR2Bucket('ATTACHMENTS')).get(file!.file_key)
      expect(sha256Hex(new Uint8Array(await stored!.arrayBuffer()))).toBe(fixture.receipt.sha256)
    } finally {
      await mf?.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000,
)
