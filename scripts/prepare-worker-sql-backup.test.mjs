import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { downloadCompletedCapture, selectCompletedCapture } from './prepare-worker-sql-backup.mjs'
const stamp = '2026-11-09T03:10:00.000Z', now = new Date('2026-11-09T04:00:00.000Z')
const prefix = 'backups/2026-11-09/12345678-1234-1234-1234-123456789abc/'
const bytes = { 'schema.json': Buffer.from('{}'), 'rows/sample/000000.json': Buffer.from('[]') }
const files = Object.fromEntries(Object.entries(bytes).map(([name, body]) => [name, {
  byte_size: body.length, sha256: createHash('sha256').update(body).digest('hex'),
}]))
const manifest = () => ({ bundle_version: '0038', exported_at: stamp, capture_id: 'abcdef12-1234-1234-1234-123456789abc', files })
const receipt = (m = manifest(), overrides = {}) => [{ success: true, results: [{ id: 10, r2_prefix: prefix, manifest_json: JSON.stringify(m), ...overrides }] }]

test('selects only an exact completed current-day lossless capture', () => {
  assert.deepEqual(selectCompletedCapture(receipt(), now), { id: 10, prefix, manifest: manifest() })
  for (const value of [[], [{ success: false, results: [] }], [{ success: true, results: [] }], [...receipt(), ...receipt()]])
    assert.throws(() => selectCompletedCapture(value, now), /completed Worker/)
})
test('refuses stale, future and legacy captures instead of falling back to live export', () => {
  for (const m of [
    { ...manifest(), exported_at: '2026-11-08T03:00:00Z' },
    { ...manifest(), exported_at: '2026-11-09T05:00:00Z' },
    { ...manifest(), bundle_version: '0037' },
    { ...manifest(), capture_id: '../../escape' },
  ]) assert.throws(() => selectCompletedCapture(receipt(m), now), /stale or invalid/)
})
test('rejects unsafe prefixes, IDs and manifest-listed paths before object I/O', () => {
  for (const overrides of [{ r2_prefix: '../../escape/' }, { id: 0 }, { manifest_json: 'not json' }])
    assert.throws(() => selectCompletedCapture(receipt(manifest(), overrides), now))
  assert.throws(() => selectCompletedCapture(receipt({ ...manifest(), files: { ...files, '../secret': files['schema.json'] } }), now))
})

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'completed-worker-copy-'))
  const directory = join(root, 'bundle')
  const capture = selectCompletedCapture(receipt(), now)
  const objects = { 'manifest.json': Buffer.from(JSON.stringify(manifest())), ...bytes }
  const calls = []
  const readObject = async (key, target) => {
    calls.push(key)
    const body = objects[key.slice(prefix.length)]
    if (!body) throw new Error('missing object')
    await writeFile(target, body)
  }
  try { await work({ root, directory, capture, objects, calls, readObject }) }
  finally { await rm(root, { recursive: true, force: true }) }
}
test('copies every authoritative member into private scratch, accepting semantic JSON order', () => fixture(async f => {
  const m = manifest()
  f.objects['manifest.json'] = Buffer.from(JSON.stringify({ files: m.files, capture_id: m.capture_id, exported_at: m.exported_at, bundle_version: m.bundle_version }))
  assert.equal(await downloadCompletedCapture(f), 2)
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700)
  for (const [name, expected] of Object.entries(bytes)) {
    assert.deepEqual(await readFile(join(f.directory, name)), expected)
    assert.equal((await stat(join(f.directory, name))).mode & 0o777, 0o600)
  }
  assert.equal(f.calls.length, 3)
}))
test('a mismatched R2 manifest refuses all row/object downloads', () => fixture(async f => {
  f.objects['manifest.json'] = Buffer.from(JSON.stringify({ ...manifest(), extra: 'not in database receipt' }))
  await assert.rejects(downloadCompletedCapture(f), /completed database receipt/)
  assert.equal(f.calls.length, 1)
}))
test('a missing member aborts the complete capture', () => fixture(async f => {
  delete f.objects['schema.json']
  await assert.rejects(downloadCompletedCapture(f), /missing object/)
}))
test('same-sized corrupt bytes fail their content checksum', () => fixture(async f => {
  f.objects['schema.json'] = Buffer.from('[]')
  await assert.rejects(downloadCompletedCapture(f), /checksum/)
}))
test('truncated members fail before a restore or archive can be published', () => fixture(async f => {
  f.objects['schema.json'] = Buffer.from('{')
  await assert.rejects(downloadCompletedCapture(f), /size/)
}))
test('scheduled workflow cannot select a live export; explicit maintenance opt-in is required', async () => {
  const workflow = await readFile(new URL('../.github/workflows/backup-sql.yml', import.meta.url), 'utf8')
  assert.match(workflow, /allow_live_sql_export:[\s\S]*?default: false/)
  const lines = workflow.split('\n')
  const exports = lines.flatMap((line, i) => /\bd1 export\b/.test(line) ? [i] : [])
  assert.equal(exports.length, 1)
  const preceding = lines.slice(exports[0] - 5, exports[0]).join('\n')
  assert.match(preceding, /if:.*github\.event_name == 'workflow_dispatch' && inputs\.allow_live_sql_export/)
  assert.match(workflow, /prepare-worker-sql-backup\.mjs/)
  assert.match(workflow, /refusing plaintext fallback/)
})

test('provider failure reports a bounded stage without leaking captured output or falling back', () => fixture(async f => {
  const bin = join(f.root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'wrangler'), '#!/bin/sh\nprintf "%s\\n" "PRIVATE-PROVIDER-SENTINEL" >&2\nexit 7\n', { mode: 0o700 })
  const error = await promisify(execFile)(process.execPath, [new URL('./prepare-worker-sql-backup.mjs', import.meta.url).pathname], {
    cwd: f.root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, D1_DATABASE_NAME: 'OwnedDb', R2_BUCKET: 'OwnedBucket',
      WORKER_BACKUP_SCRATCH: join(f.root, 'scratch'), CLOUDFLARE_API_TOKEN: '' },
  }).then(() => null, error => error)
  assert.equal(error.code, 1)
  assert.ok(!error.stdout.includes('PRIVATE-PROVIDER-SENTINEL'))
  assert.ok(!error.stderr.includes('PRIVATE-PROVIDER-SENTINEL'))
  assert.deepEqual(JSON.parse(error.stderr.trim()), { error: 'worker_backup_preparation_failed', stage: 'completion_lookup', command_exit: 7 })
}))
