// Operational L4: restore a retained SQL backup, never boot the restored app.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runDrill } from './restore-drill.mjs'
const execute = promisify(execFile)
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/

export const validateRetainedManifest = (manifest, { instance, database, now }) => {
  if (
    typeof instance !== 'string' ||
    !safeName.test(instance) ||
    typeof database !== 'string' ||
    !safeName.test(database)
  )
    throw new Error('configuration')
  const age = Date.parse(now) - Date.parse(manifest?.exported_at)
  if (
    manifest?.kind !== 'd1-sql-dump' ||
    manifest.environment !== 'prod' ||
    manifest.database !== database ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 72 * 3600_000 ||
    typeof manifest.key !== 'string' ||
    !manifest.key.startsWith(instance + '/backups/') ||
    !/^\/backups\/\d{4}\/\d{2}\/backup-\d{2}-\d{6}$/.test(manifest.key.slice(instance.length)) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !manifest.row_counts ||
    typeof manifest.row_counts !== 'object' ||
    Array.isArray(manifest.row_counts) ||
    !Number.isSafeInteger(manifest.tables) ||
    manifest.tables < 1 ||
    Object.keys(manifest.row_counts).length !== manifest.tables ||
    Object.entries(manifest.row_counts).some(
      ([name, count]) => !/^[A-Za-z0-9_]+$/.test(name) || !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    throw new Error('manifest')
  }
  return manifest
}
const summary = (result) => ({
  status: result.status,
  failed: result.failed,
  checks: Object.fromEntries(
    Object.entries(result.checks).map(([name, check]) => [
      name,
      { ok: check.ok, ...(check.skipped ? { skipped: true } : {}) },
    ]),
  ),
  counts: { tables: result.counts.tables ?? 0, rows: result.counts.rows ?? 0 },
  duration_ms: result.duration_ms,
  scratch_removed: result.scratch_removed,
})

/** Inputs/outputs are injected so the real restore can be proved without cloud credentials. */
export async function runMonthlyDrill({
  instance,
  database,
  runId,
  now = new Date().toISOString(),
  readObject,
  recordEvent,
  scratchRoot = tmpdir(),
}) {
  if (
    typeof instance !== 'string' ||
    !safeName.test(instance) ||
    typeof database !== 'string' ||
    !safeName.test(database) ||
    !/^[A-Za-z0-9._:-]{1,96}$/.test(runId)
  )
    throw new Error('Invalid drill configuration')
  let stage = 'latest_manifest',
    directory,
    manifest
  let result = {
    status: 'fail',
    failed: stage,
    checks: {},
    counts: {},
    duration_ms: 0,
    scratch_removed: true,
  }
  const started = Date.now()
  try {
    directory = await mkdtemp(join(scratchRoot, 'ezacto-monthly-drill-'))
    const latestPath = join(directory, 'latest.json')
    await readObject(`${instance}/backups/latest.json`, latestPath)
    manifest = validateRetainedManifest(JSON.parse(await readFile(latestPath, 'utf8')), {
      instance,
      database,
      now,
    })
    stage = 'retained_manifest'
    const manifestPath = join(directory, 'manifest.json')
    await readObject(manifest.key + '.manifest.json', manifestPath)
    const retained = validateRetainedManifest(JSON.parse(await readFile(manifestPath, 'utf8')), {
      instance,
      database,
      now,
    })
    // Compare semantic JSON: object property order is not provenance.
    const canonical = (value) =>
      value && typeof value === 'object'
        ? Array.isArray(value)
          ? value.map(canonical)
          : Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
            )
        : value
    if (JSON.stringify(canonical(retained)) !== JSON.stringify(canonical(manifest)))
      throw new Error('Manifest mismatch')
    stage = 'download'
    const dumpPath = join(directory, 'dump.sql.gz')
    await readObject(manifest.key + '.sql.gz', dumpPath)
    stage = 'restore'
    result = summary(
      await runDrill({ dumpPath, manifestPath, scratchRoot: directory, productInvariants: true }),
    )
    if (result.checks.row_counts?.skipped) {
      result.status = 'fail'
      result.failed = 'row_counts'
    }
  } catch {
    // Never expose driver/CLI exceptions: they may include restored row data.
    result.status = 'fail'
    result.failed = stage
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true })
      } catch {
        result.status = 'fail'
        result.failed = 'cleanup'
        result.scratch_removed = false
      }
    }
    result.duration_ms = Date.now() - started
  }
  const event = {
    eventType: 'backup.restore_drilled',
    subjectId: 1,
    actor: { type: 'system' },
    occurredAt: new Date(now).toISOString(),
    captureId: `monthly-drill:${runId}`,
    detail: {
      ...result,
      instance,
      database,
      backup_key: manifest?.key ?? null,
      backup_exported_at: manifest?.exported_at ?? null,
      backup_sha256: manifest?.sha256 ?? null,
      run_id: runId,
    },
  }
  // Persistence failure is a failed operational run; never claim a recorded pass.
  await recordEvent(event)
  return result
}

/** SQL transport only; the shared activity writer owns validation, shape and deduplication. */
export const bindActivitySql = ({ sql, params }) => {
  let index = 0
  const bound = sql.replaceAll('?', () => {
    const value = params[index++]
    if (typeof value === 'string') return `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    if (value === null) return 'NULL'
    throw new Error('Unsupported activity parameter')
  })
  if (index !== params.length) throw new Error('Activity parameter count mismatch')
  return bound + ';'
}

async function main() {
  process.umask(0o077)
  const instance = process.env.INSTANCE_FQDN,
    database = process.env.D1_DATABASE_NAME,
    bucket = process.env.R2_BUCKET,
    runId = `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT}`
  if (!safeName.test(bucket ?? '')) throw new Error('Invalid bucket configuration')
  const wrangler = async (args) =>
    execute('npx', ['--no-install', 'wrangler', ...args], {
      maxBuffer: 1024 * 1024,
      timeout: 180_000,
    })
  const result = await runMonthlyDrill({
    instance,
    database,
    runId,
    readObject: (key, file) =>
      wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file, '--remote']),
    recordEvent: async (event) => {
      const { activityCaptureStatements } = await import('../packages/db/dist/activity-log.js')
      const capture = activityCaptureStatements(event)
      const directory = await mkdtemp(join(tmpdir(), 'ezacto-drill-activity-'))
      try {
        const file = join(directory, 'activity.sql')
        await writeFile(file, capture.statements.map(bindActivitySql).join('\n'), { mode: 0o600 })
        await wrangler(['d1', 'execute', database, '--remote', '--file', file, '--yes', '--json'])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = result.status === 'pass' ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write(
      'Monthly restore drill failed; no successful recorded result is claimed.\n',
    )
    process.exitCode = 1
  })
}
