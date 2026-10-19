import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { runDrill } from './restore-drill.mjs'

// Synthetic data only. SECRET stands in for a client name or a rate: it must
// never appear in anything the drill prints.
const SECRET = 'ACME-SECRET-RATE-98765'

const GOOD = [
  'PRAGMA defer_foreign_keys=TRUE;',
  'CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
  'CREATE TABLE invoices (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), amount INTEGER);',
  'CREATE INDEX invoices_client ON invoices(client_id);',
  `INSERT INTO invoices VALUES(1,1,${SECRET.length});`,
  `INSERT INTO clients VALUES(1,'${SECRET}');`,
  "INSERT INTO clients VALUES(2,'Other');",
  '',
].join('\n')

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

function bundle(sql, overrides = {}) {
  const raw = Buffer.from(sql)
  const gz = gzipSync(raw)
  return {
    gz,
    manifest: {
      kind: 'd1-sql-dump',
      tables: 2,
      insert_statements: 3,
      uncompressed_bytes: raw.length,
      compressed_bytes: gz.length,
      sha256: sha(gz),
      ...overrides,
    },
  }
}

let root
let scratchRoot
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'restore-drill-test-'))
  scratchRoot = join(root, 'scratch')
  await mkdir(scratchRoot)
})
after(() => rm(root, { recursive: true, force: true }))

let n = 0
async function drill({ gz, manifest }, opts = {}) {
  const id = n++
  const dumpPath = join(root, `${id}.sql.gz`)
  const manifestPath = join(root, `${id}.manifest.json`)
  await writeFile(dumpPath, gz)
  await writeFile(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return runDrill({ dumpPath, manifestPath, scratchRoot, ...opts })
}

const scratchEmpty = async () => assert.deepEqual(await readdir(scratchRoot), [])

test('a good dump passes every check and reports counts only', async () => {
  let mode
  let dirMode
  const r = await drill(bundle(GOOD), {
    beforeCleanup: async (file) => {
      mode = (await stat(file)).mode & 0o777
      dirMode = (await stat(dirname(file))).mode & 0o777
    },
  })
  assert.equal(r.status, 'pass')
  assert.equal(r.failed, null)
  assert.equal(r.counts.tables, 2)
  assert.equal(r.counts.rows, 3)
  assert.deepEqual(r.counts.per_table, { clients: 2, invoices: 1 })
  assert.equal(r.checks.integrity_check.ok, true)
  assert.equal(r.checks.foreign_key_check.ok, true)
  assert.equal(r.checks.row_counts.skipped, true)
  assert.equal(mode, 0o600)
  assert.equal(dirMode, 0o700)
  assert.equal(r.scratch_removed, true)
  assert.ok(!JSON.stringify(r).includes(SECRET))
  await scratchEmpty()
})

test('per-table row counts in the manifest are compared when present', async () => {
  const ok = await drill(bundle(GOOD, { row_counts: { clients: 2, invoices: 1 } }))
  assert.equal(ok.status, 'pass')
  assert.equal(ok.checks.row_counts.ok, true)
  assert.equal(ok.checks.row_counts.skipped, undefined)
  const bad = await drill(bundle(GOOD, { row_counts: { clients: 2, invoices: 5 } }))
  assert.equal(bad.failed, 'row_counts')
  assert.match(bad.checks.row_counts.detail, /invoices/)
  await scratchEmpty()
})

test('a flipped byte fails the sha256 check', async () => {
  const b = bundle(GOOD)
  const gz = Buffer.from(b.gz)
  gz[Math.floor(gz.length / 2)] ^= 0xff
  const r = await drill({ gz, manifest: b.manifest })
  assert.equal(r.status, 'fail')
  assert.equal(r.failed, 'sha256')
  await scratchEmpty()
})

test('a truncated dump fails the sha256 check', async () => {
  const b = bundle(GOOD)
  const r = await drill({ gz: b.gz.subarray(0, b.gz.length - 10), manifest: b.manifest })
  assert.equal(r.failed, 'sha256')
  await scratchEmpty()
})

test('a wrong manifest sha fails the sha256 check', async () => {
  const r = await drill(bundle(GOOD, { sha256: '0'.repeat(64) }))
  assert.equal(r.failed, 'sha256')
})

test('a truncated dump whose manifest was rewritten fails on gzip', async () => {
  const b = bundle(GOOD)
  const gz = b.gz.subarray(0, b.gz.length - 10)
  const r = await drill({
    gz,
    manifest: { ...b.manifest, sha256: sha(gz), compressed_bytes: undefined },
  })
  assert.equal(r.failed, 'gunzip')
  await scratchEmpty()
})

test('a matching checksum over broken SQL fails the load and leaks no row text', async () => {
  const broken = GOOD.replace("'Other');", `'Other', '${SECRET}' ??? ;`)
  const r = await drill(bundle(broken, { tables: undefined, insert_statements: undefined }))
  assert.equal(r.failed, 'load')
  assert.ok(!JSON.stringify(r).includes(SECRET))
  assert.equal(r.scratch_removed, true)
  await scratchEmpty()
})

test('a foreign-key violation fails foreign_key_check', async () => {
  const orphan = `${GOOD}INSERT INTO invoices VALUES(2,99,1);\n`
  const r = await drill(bundle(orphan, { insert_statements: 4 }))
  assert.equal(r.failed, 'foreign_key_check')
  assert.equal(r.checks.integrity_check.ok, true)
  assert.ok(!JSON.stringify(r).includes(SECRET))
  await scratchEmpty()
})

test('table and insert counts must match the manifest', async () => {
  const tables = await drill(bundle(GOOD, { tables: 3 }))
  assert.equal(tables.failed, 'table_count')
  const inserts = await drill(bundle(GOOD, { insert_statements: 9 }))
  assert.equal(inserts.failed, 'insert_statements')
  await scratchEmpty()
})

test('byte counts must match the manifest', async () => {
  assert.equal((await drill(bundle(GOOD, { compressed_bytes: 1 }))).failed, 'compressed_bytes')
  assert.equal((await drill(bundle(GOOD, { uncompressed_bytes: 1 }))).failed, 'uncompressed_bytes')
})

test('a bad manifest fails before anything is loaded', async () => {
  const b = bundle(GOOD)
  assert.equal((await drill({ gz: b.gz, manifest: 'not json' })).failed, 'manifest')
  assert.equal((await drill({ gz: b.gz, manifest: { tables: 2 } })).failed, 'manifest')
  await scratchEmpty()
})

test('the command exits 0 on a good dump, 1 on a corrupt one, 2 on bad usage', async () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'restore-drill.mjs')
  const good = bundle(GOOD)
  await writeFile(join(root, 'cli.sql.gz'), good.gz)
  await writeFile(join(root, 'cli.manifest.json'), JSON.stringify(good.manifest))
  await writeFile(
    join(root, 'cli-bad.manifest.json'),
    JSON.stringify({ ...good.manifest, sha256: 'f'.repeat(64) }),
  )
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

  const ok = run(join(root, 'cli.sql.gz'), join(root, 'cli.manifest.json'))
  assert.equal(ok.status, 0)
  assert.equal(JSON.parse(ok.stdout).status, 'pass')

  const bad = run(join(root, 'cli.sql.gz'), join(root, 'cli-bad.manifest.json'))
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /sha256/)
  assert.ok(!(bad.stdout + bad.stderr).includes(SECRET))

  assert.equal(run().status, 2)
})
