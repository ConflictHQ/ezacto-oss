import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  runMonthlyDrill,
  validateRetainedManifest,
  bindActivitySql,
} from './monthly-restore-drill.mjs'
import { sealSqlBackup } from './seal-sql-backup.mjs'
const now = '2026-10-22T06:00:00.000Z',
  instance = 'books.example.test',
  database = 'books-prod'
const raw = Buffer.from(
  [
    'CREATE TABLE clients(id INTEGER PRIMARY KEY,name TEXT CHECK(length(name)>0));',
    "INSERT INTO clients VALUES(1,'PRIVATE CLIENT ROW NEVER LOG');",
    'CREATE TABLE invoices(id INTEGER PRIMARY KEY, amount_cents INTEGER, due_amount_cents INTEGER, discount_amount_cents INTEGER, tax_amount_cents INTEGER, tax2_amount_cents INTEGER, written_off_cents INTEGER);',
    'INSERT INTO invoices VALUES(1,50,50,0,0,0,0);',
    'CREATE TABLE invoice_line_items(invoice_id INTEGER REFERENCES invoices(id),amount_cents INTEGER);',
    'INSERT INTO invoice_line_items VALUES(1,50);',
    'CREATE TABLE invoice_payments(invoice_id INTEGER REFERENCES invoices(id),amount_cents INTEGER);',
    'CREATE TABLE invoice_command_ledger(completed INTEGER);',
    'INSERT INTO invoice_command_ledger VALUES(1);',
    '',
  ].join('\n'),
)
const dump = gzipSync(raw)
const fixture = () => ({
  kind: 'd1-sql-dump',
  environment: 'prod',
  database,
  exported_at: '2026-10-22T04:00:00.000Z',
  key: instance + '/backups/2026/10/backup-22-040000',
  sha256: createHash('sha256').update(dump).digest('hex'),
  tables: 5,
  insert_statements: 4,
  compressed_bytes: dump.length,
  uncompressed_bytes: raw.length,
  row_counts: {
    clients: 1,
    invoices: 1,
    invoice_line_items: 1,
    invoice_payments: 0,
    invoice_command_ledger: 1,
  },
})
async function run(change = {}) {
  const root = await mkdtemp(join(tmpdir(), 'monthly-drill-test-')),
    events = [],
    reads = []
  const manifest = fixture()
  const objects = new Map([
    [instance + '/backups/latest.json', JSON.stringify(manifest)],
    [manifest.key + '.manifest.json', JSON.stringify(manifest)],
    [manifest.key + '.sql.gz', dump],
  ])
  change.objects?.(objects, manifest)
  try {
    const result = await runMonthlyDrill({
      instance,
      database,
      now,
      runId: '123.1',
      scratchRoot: root,
      readObject: async (key, file) => {
        reads.push(key)
        const body = objects.get(key)
        if (body === undefined) throw new Error('PRIVATE PROVIDER ERROR')
        await writeFile(file, body)
      },
      recordEvent: async (event) => {
        assert.deepEqual(await readdir(root), [])
        events.push(event)
        if (change.recordFails) throw new Error('persist failed')
      },
    })
    assert.deepEqual(await readdir(root), [])
    assert.equal(events.length, 1)
    assert.equal(events[0].eventType, 'backup.restore_drilled')
    assert.equal(events[0].captureId, 'monthly-drill:123.1')
    assert.deepEqual(events[0].actor, { type: 'system' })
    assert.ok(!JSON.stringify({ result, events }).includes('PRIVATE'))
    return { result, events, reads }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test('latest retained backup is restored, every table count compared, scratch removed before the event', async () => {
  const { result, events, reads } = await run()
  assert.equal(result.status, 'pass')
  assert.deepEqual(result.counts, { tables: 5, rows: 4 })
  assert.deepEqual(result.checks.row_counts, { ok: true })
  assert.equal(result.scratch_removed, true)
  assert.equal(reads.length, 3)
  assert.equal(events[0].detail.backup_sha256, fixture().sha256)
})
test('corruption of the already retained object records a failure without restored data', async () => {
  const { result } = await run({
    objects: (objects, m) => {
      const corrupted = Buffer.from(dump)
      corrupted[10] ^= 255
      objects.set(m.key + '.sql.gz', corrupted)
    },
  })
  assert.equal(result.status, 'fail')
  assert.equal(result.failed, 'sha256')
  assert.equal(result.scratch_removed, true)
})
test('count drift is refused even when checksum matches', async () => {
  const { result } = await run({
    objects: (objects, m) => {
      m.row_counts.clients = 2
      objects.set(instance + '/backups/latest.json', JSON.stringify(m))
      objects.set(m.key + '.manifest.json', JSON.stringify(m))
    },
  })
  assert.equal(result.status, 'fail')
  assert.equal(result.failed, 'row_counts')
})
test('a missing object and a changed retained manifest record distinct failures', async () => {
  const missing = await run({ objects: (objects, m) => objects.delete(m.key + '.sql.gz') })
  assert.equal(missing.result.failed, 'download')
  const changed = await run({
    objects: (objects, m) =>
      objects.set(m.key + '.manifest.json', JSON.stringify({ ...m, release: 'different' })),
  })
  assert.equal(changed.result.failed, 'retained_manifest')
})
test('stale, future, foreign, traversal and incomplete manifests never select a dump', async () => {
  for (const patch of [
    { exported_at: '2026-10-01T00:00:00.000Z' },
    { exported_at: '2026-10-23T00:00:00.000Z' },
    { database: 'another' },
    { environment: 'dev' },
    { key: 'elsewhere/backups/2026/10/backup-22-040000' },
    { key: instance + '/backups/../backups/2026/10/backup-22-040000' },
    { row_counts: undefined },
  ]) {
    const { result, reads } = await run({
      objects: (objects) =>
        objects.set(instance + '/backups/latest.json', JSON.stringify({ ...fixture(), ...patch })),
    })
    assert.equal(result.failed, 'latest_manifest')
    assert.equal(reads.length, 1)
  }
  assert.throws(() => validateRetainedManifest(fixture(), { instance: undefined, database, now }))
})
test('event persistence failure cannot be reported as operational success', async () => {
  await assert.rejects(run({ recordFails: true }), /persist failed/)
})
test('nightly sealing derives counts from a real restore and leaves a corrupt manifest untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seal-drill-test-'))
  const dumpPath = join(root, 'dump.gz'),
    manifestPath = join(root, 'manifest.json')
  try {
    const original = { ...fixture() }
    delete original.row_counts
    await writeFile(dumpPath, dump)
    await writeFile(manifestPath, JSON.stringify(original))
    assert.deepEqual(await sealSqlBackup({ dumpPath, manifestPath }), { tables: 5, rows: 4 })
    assert.deepEqual(
      JSON.parse(await readFile(manifestPath, 'utf8')).row_counts,
      fixture().row_counts,
    )
    const before = await readFile(manifestPath, 'utf8')
    await writeFile(dumpPath, 'corrupted')
    await assert.rejects(sealSqlBackup({ dumpPath, manifestPath }), /verification failed/)
    assert.equal(await readFile(manifestPath, 'utf8'), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('SQL activity transport encodes strings as data and refuses unsupported parameters', () => {
  const sql = bindActivitySql({
    sql: 'SELECT ?,?,?',
    params: ["quote' -- arbitrary\ntext", 3, null],
  })
  assert.match(sql, /CAST\(X'[0-9a-f]+' AS TEXT\),3,NULL/)
  assert.ok(!sql.includes('arbitrary'))
  assert.throws(() => bindActivitySql({ sql: 'SELECT ?', params: [undefined] }))
  assert.throws(() => bindActivitySql({ sql: 'SELECT ?', params: [] }))
})

test('a checksummed dump with inconsistent invoice money or incomplete receipts fails invariants', async () => {
  for (const text of [
    raw.toString().replace('VALUES(1,50,50,0,0,0,0)', 'VALUES(1,999,999,0,0,0,0)'),
    raw.toString().replace('invoice_command_ledger VALUES(1)', 'invoice_command_ledger VALUES(0)'),
  ]) {
    const changed = gzipSync(text)
    const { result } = await run({
      objects: (objects, manifest) => {
        manifest.sha256 = createHash('sha256').update(changed).digest('hex')
        manifest.compressed_bytes = changed.length
        manifest.uncompressed_bytes = Buffer.byteLength(text)
        objects.set(instance + '/backups/latest.json', JSON.stringify(manifest))
        objects.set(manifest.key + '.manifest.json', JSON.stringify(manifest))
        objects.set(manifest.key + '.sql.gz', changed)
      },
    })
    assert.equal(result.status, 'fail')
    assert.equal(result.failed, 'product_invariants')
    assert.equal(result.scratch_removed, true)
  }
})
