import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { AwsClient } from 'aws4fetch'
import { afterEach, expect, it } from 'vitest'
import { backupBase64, backupSha256, decryptBackupObject } from '@ezacto/core'
import { createD1SessionStore } from '../../../packages/db/src/sessions.js'
const endpoint = process.env.EZACTO_TEST_MINIO_ENDPOINT
let worker: Miniflare | undefined
afterEach(async () => worker?.dispose())
it.skipIf(!endpoint)(
  '[native MinIO #38] real minute cron encrypts a recorded L1 bundle and reports separate L2 status',
  async () => {
    const credentials = {
        accessKeyId: 'ezacto-backup-fixture',
        secretAccessKey: 'local-backup-fixture-only',
      },
      bucket = `worker-backup-${crypto.randomUUID()}`
    const aws = new AwsClient({ ...credentials, region: 'us-east-1', service: 's3', retries: 0 })
    expect((await fetch(await aws.sign(`${endpoint}/${bucket}`, { method: 'PUT' }))).status).toBe(
      200,
    )
    const key = crypto.getRandomValues(new Uint8Array(32))
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
        RELEASE: 'offsite-backup-fixture',
        APP_BASE_URL: 'https://worker.test',
        EZACTO_BACKUP_S3_ENDPOINT: endpoint!,
        EZACTO_BACKUP_S3_REGION: 'us-east-1',
        EZACTO_BACKUP_S3_BUCKET: bucket,
        EZACTO_BACKUP_S3_PREFIX: 'native-fixture',
        EZACTO_BACKUP_S3_ACCESS_KEY_ID: credentials.accessKeyId,
        EZACTO_BACKUP_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        EZACTO_BACKUP_ENCRYPTION_KEY: backupBase64(key),
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
      r2 = await worker.getR2Bucket('ATTACHMENTS'),
      stamp = new Date().toISOString()
    await d1
      .prepare(
        "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Backup fixture','{}',?,?)",
      )
      .bind(stamp, stamp)
      .run()
    await d1
      .prepare(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Backup','Administrator','administrator','[]',?,?)",
      )
      .bind(stamp, stamp)
      .run()
    const table = new TextEncoder().encode('id,private_note\n1,sensitive native backup fixture\n')
    const manifest = {
        schema_version: 1,
        bundle_version: '0037',
        exported_at: stamp,
        tables: { users: { row_count: 1, sha256: await backupSha256(table) } },
        table_count: 1,
        total_rows: 1,
        restore_skips: [],
      },
      json = JSON.stringify(manifest)
    await r2.put('backups/native/tables/users.csv', table)
    await r2.put('backups/native/RESTORE.md', 'Native logical fixture recovery instructions')
    await r2.put('backups/native/manifest.json', json)
    await d1
      .prepare(
        "INSERT INTO backup_runs(id,status,trigger,started_at,completed_at,r2_prefix,manifest_json,table_count,total_rows,created_at,updated_at) VALUES(1,'completed','nightly',?,?,'backups/native/',?,1,1,?,?)",
      )
      .bind(stamp, stamp, json, stamp, stamp)
      .run()
    const session = await createD1SessionStore(d1).issue(1)
    const headers = {
      cookie: `__Host-ezacto_session=${session.token}`,
      origin: 'https://worker.test',
    }
    const tick = () =>
      worker!.dispatchFetch(
        `https://worker.test/cdn-cgi/handler/scheduled?time=${Date.now()}&cron=*+*+*+*+*`,
      )
    expect((await tick()).status).toBe(200)
    const status = await worker.dispatchFetch('https://worker.test/api/v1/backup/status', {
      headers,
    })
    expect(status.status).toBe(200)
    const body = (await status.json()) as {
      data: {
        last_completed: { id: number }
        offsite: {
          state: string
          last_completed: { id: string; uploaded_objects: number; total_objects: number }
        }
      }
    }
    expect(body.data.last_completed.id).toBe(1)
    expect(body.data.offsite).toMatchObject({
      state: 'completed',
      error: null,
      last_completed: { uploaded_objects: 3, total_objects: 3 },
    })
    const id = body.data.offsite.last_completed.id
    const response = await fetch(
      await aws.sign(`${endpoint}/${bucket}/native-fixture/runs/${id}/tables/users.csv.ezenc`),
    )
    expect(response.status).toBe(200)
    const cipher = new Uint8Array(await response.arrayBuffer())
    expect(new TextDecoder().decode(cipher)).not.toContain('sensitive native backup fixture')
    expect((await decryptBackupObject(cipher, key)).bytes).toEqual(table)
    const preflight = await worker.dispatchFetch(
      'https://worker.test/api/v1/backup/offsite/check',
      { method: 'POST', headers },
    )
    expect(preflight.status).toBe(200)
    expect(await preflight.json()).toMatchObject({ data: { verified: true } })
    await tick()
    expect(
      (await d1.prepare('SELECT COUNT(*) AS count FROM offsite_backup_syncs').first())?.count,
    ).toBe(1)
    expect(
      (await d1.prepare('SELECT COUNT(*) AS count FROM offsite_backup_objects').first())?.count,
    ).toBe(3)
  },
  30000,
)
