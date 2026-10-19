import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BackupArchiveError,
  getBackupRun,
  openBackupArchive,
  r2BackupSource,
  type BackupObjectSource,
} from '../src/backup-archive.js'
import {
  completeBackupRun,
  exportBundle,
  recordBackupStart,
  type BackupObjectStore,
} from '../src/backup.js'
import { migrateD1 } from '../src/migrate.js'

const now = '2026-09-01T03:00:00.000Z'
const prefix = 'backups/2026-09-01/'

const miniflares: Miniflare[] = []
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((m) => m.dispose()))
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

const setup = async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    r2Buckets: ['BUCKET'],
  })
  miniflares.push(miniflare)
  const database = await miniflare.getD1Database('DB')
  const bucket = (await miniflare.getR2Bucket('BUCKET')) as unknown as R2Bucket
  await migrateD1(database)
  await database
    .prepare(
      `INSERT INTO clients (name, currency, created_at, updated_at) VALUES ('café, "quoted"', 'USD', ?, ?)`,
    )
    .bind(now, now)
    .run()
  const store: BackupObjectStore = {
    async put(key, body) {
      await bucket.put(key, body)
    },
  }
  const manifest = await exportBundle(database, store, prefix)
  const runId = await recordBackupStart(database, 'manual', now)
  await completeBackupRun(database, runId, manifest, prefix, now)
  const run = (await getBackupRun(database, runId))!
  return { database, bucket, run, manifest }
}

describe('backup archive stream', () => {
  it('[unit] a completed run opens with standard tools, files byte-identical to R2', async () => {
    const { bucket, run, manifest } = await setup()
    const bytes = await readAll(await openBackupArchive(run, r2BackupSource(bucket)))

    const dir = mkdtempSync(join(tmpdir(), 'ezacto-archive-'))
    scratch.push(dir)
    const file = join(dir, 'bundle.zip')
    writeFileSync(file, bytes)
    // unzip -t checks every CRC and the central directory.
    expect(execFileSync('unzip', ['-t', file]).toString()).toContain('No errors detected')
    const listing = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n')
    expect(listing).toEqual([
      'manifest.json',
      'RESTORE.md',
      ...Object.keys(manifest.tables)
        .sort()
        .map((t) => `tables/${t}.csv`),
    ])

    for (const name of listing) {
      const fromZip = execFileSync('unzip', ['-p', file, name], { maxBuffer: 1 << 26 })
      const object = await bucket.get(`${prefix}${name}`)
      const fromR2 = Buffer.from(await object!.arrayBuffer())
      expect(new Uint8Array(fromZip)).toEqual(new Uint8Array(fromR2))
    }
    expect(readFileSync(file).length).toBe(bytes.length)
  })

  it('[unit] carries non-ASCII data intact', async () => {
    const { bucket, run } = await setup()
    const bytes = await readAll(await openBackupArchive(run, r2BackupSource(bucket)))
    const dir = mkdtempSync(join(tmpdir(), 'ezacto-archive-'))
    scratch.push(dir)
    const file = join(dir, 'bundle.zip')
    writeFileSync(file, bytes)
    const csv = new TextDecoder().decode(execFileSync('unzip', ['-p', file, 'tables/clients.csv']))
    expect(csv).toContain('"café, ""quoted"""')
  })

  it('[security] a table object that no longer matches the manifest aborts the stream, sending none of its bytes', async () => {
    const { bucket, run, manifest } = await setup()
    const tables = Object.keys(manifest.tables).sort()
    const victim = tables[Math.floor(tables.length / 2)]!
    await bucket.put(`${prefix}tables/${victim}.csv`, 'tampered\n')

    const stream = await openBackupArchive(run, r2BackupSource(bucket))
    const reader = stream.getReader()
    const received: Uint8Array[] = []
    let failure: unknown
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received.push(value)
      }
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(BackupArchiveError)
    expect((failure as BackupArchiveError).code).toBe('checksum_mismatch')
    expect(new TextDecoder().decode(Buffer.concat(received))).not.toContain('tampered')
  })

  it('[security] a missing table object aborts the stream', async () => {
    const { bucket, run, manifest } = await setup()
    await bucket.delete(`${prefix}tables/${Object.keys(manifest.tables)[0]!}.csv`)
    await expect(
      readAll(await openBackupArchive(run, r2BackupSource(bucket))),
    ).rejects.toMatchObject({ code: 'object_missing' })
  })

  it('[security] refuses a manifest object that differs from the one D1 recorded', async () => {
    const { bucket, run, manifest } = await setup()
    const forged = { ...manifest, tables: { ...manifest.tables } }
    const name = Object.keys(forged.tables)[0]!
    forged.tables[name] = { row_count: 0, sha256: '0'.repeat(64) }
    await bucket.put(`${prefix}manifest.json`, JSON.stringify(forged, null, 2))
    await expect(openBackupArchive(run, r2BackupSource(bucket))).rejects.toMatchObject({
      code: 'manifest_mismatch',
    })
  })

  it('[security] refuses a manifest that names a table with a path in it', async () => {
    const { bucket, run } = await setup()
    const hostile = {
      ...run,
      manifest_json: JSON.stringify({
        exported_at: now,
        tables: { '../other/secret': { row_count: 0, sha256: '0'.repeat(64) } },
      }),
    }
    await bucket.put(`${prefix}manifest.json`, hostile.manifest_json)
    await expect(openBackupArchive(hostile, r2BackupSource(bucket))).rejects.toMatchObject({
      code: 'manifest_mismatch',
    })
  })

  it('[unit] refuses runs that did not complete', async () => {
    const { bucket, run } = await setup()
    await expect(
      openBackupArchive({ ...run, status: 'failed' }, r2BackupSource(bucket)),
    ).rejects.toMatchObject({ code: 'run_not_exportable' })
    await expect(
      openBackupArchive({ ...run, r2_prefix: null }, r2BackupSource(bucket)),
    ).rejects.toMatchObject({ code: 'run_not_exportable' })
  })

  it('[unit] reads objects as the consumer pulls, never the whole bundle up front', async () => {
    const { bucket, run, manifest } = await setup()
    const reads: string[] = []
    const inner = r2BackupSource(bucket)
    const counting: BackupObjectSource = {
      async get(key) {
        reads.push(key)
        return inner.get(key)
      },
    }
    const stream = await openBackupArchive(run, counting)
    const reader = stream.getReader()
    await reader.read()
    await reader.read()
    await reader.read()
    // The manifest read to open, then at most the entries pulled (plus the
    // stream's one-chunk look-ahead), far fewer than every table.
    expect(Object.keys(manifest.tables).length).toBeGreaterThan(20)
    expect(reads.length).toBeLessThan(8)
    await reader.cancel()
  })

  it('[unit] a bundle with many large objects streams without a whole-bundle buffer', async () => {
    const size = 4 * 1024 * 1024
    const count = 40
    const blob = new Uint8Array(size).fill(97)
    const hashHex = async (data: Uint8Array) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    const sha256 = await hashHex(blob)
    const tables: Record<string, { row_count: number; sha256: string }> = {}
    for (let i = 0; i < count; i++) tables[`t${i}`] = { row_count: 1, sha256 }
    const manifest = { exported_at: now, tables }
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    let live = 0
    let peak = 0
    const source: BackupObjectSource = {
      async get(key) {
        if (key.endsWith('manifest.json')) return manifestBytes
        if (key.endsWith('RESTORE.md')) return new Uint8Array([35])
        live += 1
        peak = Math.max(peak, live)
        return blob
      },
    }
    const stream = await openBackupArchive(
      { id: 1, status: 'completed', r2_prefix: prefix, manifest_json: JSON.stringify(manifest) },
      source,
    )
    const reader = stream.getReader()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      live = 0 // the consumer has taken the chunk; nothing is retained
    }
    expect(total).toBeGreaterThan(count * size)
    expect(peak).toBeLessThanOrEqual(2)
  })
})
