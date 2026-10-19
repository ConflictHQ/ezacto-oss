// Restore drill, slice 1 (issue 40). Proves a nightly SQL dump can actually be
// restored: the file matches its manifest, loads into a fresh SQLite database,
// passes integrity and foreign-key checks, and holds what the manifest says.
//
//   node scripts/restore-drill.mjs <dump.sql.gz> <manifest.json>
//
// Prints one JSON result on stdout and exits 0 on pass, 1 on any failed check,
// 2 on bad usage. The result carries counts, names of failed checks and
// durations only. It never carries row values: the restored file holds every
// client, rate and invoice, so nothing derived from its contents beyond
// aggregate numbers is written anywhere.
//
// The scratch database lives in a private temp directory (0700 dir, 0600 file)
// and is removed on success and on failure. No network is used.
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

// Error text from the SQLite driver can quote the statement it choked on, and a
// statement is row data. Keep the leading message and drop anything quoted.
const scrub = (err) =>
  String(err?.message ?? err)
    .split(/\bnear\b/)[0]
    .replace(/["'`][^"'`]*["'`]/g, '?')
    .slice(0, 120)
    .trim()

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`

// Counts INSERT statements without keeping any of their text.
function countInserts(sql) {
  let n = 0
  for (const line of sql.split('\n')) if (line.startsWith('INSERT INTO')) n++
  return n
}

function readManifest(text) {
  let m
  try {
    m = JSON.parse(text)
  } catch {
    throw new Error('manifest is not valid JSON')
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m))
    throw new Error('manifest is not an object')
  if (!/^[0-9a-f]{64}$/.test(String(m.sha256 ?? ''))) throw new Error('manifest has no sha256')
  return m
}

/**
 * Runs the drill. A failed check is a result, not an exception.
 * `scratchRoot` is where the private scratch directory is made. `beforeCleanup`
 * is called with the scratch database path just before it is removed, so a test
 * can look at the file's mode.
 */
export async function runDrill({ dumpPath, manifestPath, scratchRoot = tmpdir(), beforeCleanup }) {
  const started = Date.now()
  const checks = {}
  const result = {
    status: 'fail',
    failed: null,
    checks,
    counts: {},
    duration_ms: 0,
    scratch_removed: false,
  }
  const fail = (name, detail) => {
    checks[name] = { ok: false, detail }
    result.failed ??= name
  }
  const pass = (name, detail) => {
    checks[name] = { ok: true, ...(detail === undefined ? {} : { detail }) }
  }

  let dir
  let db
  let stage = 'load'
  try {
    let manifest
    stage = 'manifest'
    try {
      manifest = readManifest(await readFile(manifestPath, 'utf8'))
      pass('manifest')
    } catch (e) {
      fail('manifest', scrub(e))
      return result
    }

    stage = 'sha256'
    let gz
    try {
      gz = await readFile(dumpPath)
    } catch {
      fail('sha256', 'dump file is unreadable')
      return result
    }
    if (createHash('sha256').update(gz).digest('hex') !== manifest.sha256) {
      fail('sha256', 'dump does not match the manifest checksum')
      return result
    }
    pass('sha256')

    if (manifest.compressed_bytes !== undefined) {
      if (gz.length !== manifest.compressed_bytes) {
        fail('compressed_bytes', `${gz.length} bytes, manifest says ${manifest.compressed_bytes}`)
        return result
      }
      pass('compressed_bytes')
    }

    stage = 'gunzip'
    let sql
    try {
      sql = gunzipSync(gz)
      pass('gunzip')
    } catch (e) {
      fail('gunzip', scrub(e))
      return result
    }
    if (manifest.uncompressed_bytes !== undefined) {
      if (sql.length !== manifest.uncompressed_bytes) {
        fail(
          'uncompressed_bytes',
          `${sql.length} bytes, manifest says ${manifest.uncompressed_bytes}`,
        )
        return result
      }
      pass('uncompressed_bytes')
    }
    const text = sql.toString('utf8')

    stage = 'load'
    dir = await mkdtemp(join(scratchRoot, 'ezacto-restore-drill-'))
    await chmod(dir, 0o700)
    const file = join(dir, 'restored.sqlite')
    db = new DatabaseSync(file)
    await chmod(file, 0o600)
    // Foreign keys are checked after the load, not enforced during it: a dump
    // lists tables in name order, not dependency order.
    db.exec('PRAGMA foreign_keys = OFF')
    const loadStart = Date.now()
    try {
      db.exec(text)
      pass('load', { ms: Date.now() - loadStart })
    } catch (e) {
      fail('load', scrub(e))
      return result
    }

    stage = 'integrity_check'
    const integrity = db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((r) => String(Object.values(r)[0]))
    if (integrity.length === 1 && integrity[0] === 'ok') pass('integrity_check')
    else fail('integrity_check', `${integrity.length} problem(s) reported`)

    stage = 'foreign_key_check'
    const fk = db.prepare('PRAGMA foreign_key_check').all()
    if (fk.length === 0) pass('foreign_key_check')
    else fail('foreign_key_check', `${fk.length} violation(s)`)

    stage = 'table_count'
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all()
      .map((r) => r.name)
    const counts = {}
    for (const t of tables)
      counts[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)}`).get().n)
    result.counts = {
      tables: tables.length,
      rows: Object.values(counts).reduce((a, b) => a + b, 0),
      per_table: counts,
    }

    if (manifest.tables !== undefined) {
      if (tables.length === manifest.tables) pass('table_count')
      else fail('table_count', `${tables.length} tables, manifest says ${manifest.tables}`)
    }
    stage = 'insert_statements'
    if (manifest.insert_statements !== undefined) {
      const n = countInserts(text)
      if (n === manifest.insert_statements) pass('insert_statements')
      else fail('insert_statements', `${n} inserts, manifest says ${manifest.insert_statements}`)
    }
    // Per-table counts are compared when the manifest carries them. The nightly
    // manifest does not yet, and then the check reports as skipped, not passed.
    stage = 'row_counts'
    if (manifest.row_counts && typeof manifest.row_counts === 'object') {
      const diffs = [
        ...new Set([...Object.keys(counts), ...Object.keys(manifest.row_counts)]),
      ].filter((t) => counts[t] !== manifest.row_counts[t])
      if (diffs.length === 0) pass('row_counts')
      else fail('row_counts', `${diffs.length} table(s) differ: ${diffs.slice(0, 10).join(', ')}`)
    } else {
      checks.row_counts = { ok: true, skipped: true, detail: 'manifest has no row_counts' }
    }
  } catch (e) {
    fail(stage, scrub(e))
  } finally {
    try {
      db?.close()
    } catch {
      // The scratch directory is removed regardless.
    }
    if (dir) {
      await beforeCleanup?.(join(dir, 'restored.sqlite'))
      await rm(dir, { recursive: true, force: true })
      result.scratch_removed = await stat(dir).then(
        () => false,
        () => true,
      )
    } else {
      result.scratch_removed = true
    }
    if (result.failed === null) result.status = 'pass'
    result.duration_ms = Date.now() - started
  }
  return result
}

async function main(argv) {
  const [dumpPath, manifestPath] = argv
  if (!dumpPath || !manifestPath || argv.length !== 2) {
    process.stderr.write('usage: node scripts/restore-drill.mjs <dump.sql.gz> <manifest.json>\n')
    return 2
  }
  const result = await runDrill({ dumpPath, manifestPath })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status !== 'pass') process.stderr.write(`restore drill failed: ${result.failed}\n`)
  return result.status === 'pass' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
