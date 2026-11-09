// Build the operational SQL/offsite artifacts from a completed Worker capture.
// D1 is only queried for its completion receipt; this never invokes D1 export.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { workerBackupFiles } from '../packages/core/dist/index.js'
const execute = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  : value
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/
let preparationStage = 'configuration'

export const classifyWranglerFailure = error => {
  const output = `${error?.stderr ?? ''} ${error?.stdout ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '')
  const match = /\[code: (\d{3,8})\]/.exec(output)
  const providerCode = match ? Number(match[1]) : undefined
  const category = /authentication error|unauthorized|not authorized|forbidden/i.test(output) ? 'authentication'
    : /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network error/i.test(output) ? 'network'
      : error?.code === 'ENOENT' ? 'command_missing' : 'provider_command'
  return { category, ...(providerCode ? { provider_code: providerCode } : {}) }
}
const wrangler = async (args, options) => {
  try { return await execute('wrangler', args, options) }
  catch (error) { error.safeProviderFailure = classifyWranglerFailure(error); throw error }
}

export const selectCompletedCapture = (response, now = new Date()) => {
  const rows = response?.[0]?.results
  if (response?.length !== 1 || response[0].success !== true || !Array.isArray(rows) || rows.length !== 1)
    throw new Error('No completed Worker backup is available for today.')
  const row = rows[0]
  let manifest
  try { manifest = JSON.parse(row.manifest_json) } catch { throw new Error('Invalid Worker completion receipt.') }
  const age = now.valueOf() - Date.parse(manifest?.exported_at)
  if (!Number.isSafeInteger(row.id) || row.id < 1 ||
      typeof row.r2_prefix !== 'string' || !/^backups\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/$/.test(row.r2_prefix) ||
      !uuid.test(row.r2_prefix.split('/')[2]) || manifest?.bundle_version !== '0038' ||
      typeof manifest.capture_id !== 'string' || !uuid.test(manifest.capture_id) ||
      !Number.isFinite(age) || age < 0 || age > 24 * 3600_000 ||
      manifest.exported_at.slice(0, 10) !== now.toISOString().slice(0, 10) ||
      row.r2_prefix.split('/')[1] !== manifest.exported_at.slice(0, 10))
    throw new Error('Worker backup completion receipt is stale or invalid.')
  workerBackupFiles(manifest.files)
  return { id: row.id, prefix: row.r2_prefix, manifest }
}

/** Exact receipts, safe paths and every authoritative object before any restore. */
export async function downloadCompletedCapture({ capture, directory, readObject }) {
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const manifestPath = join(directory, 'manifest.json')
  await readObject(capture.prefix + 'manifest.json', manifestPath)
  if ((await stat(manifestPath)).size > 16 * 1024 * 1024) throw new Error('Worker manifest exceeds its limit.')
  const bytes = await readFile(manifestPath)
  const downloaded = JSON.parse(bytes.toString('utf8'))
  if (JSON.stringify(canonical(downloaded)) !== JSON.stringify(canonical(capture.manifest)))
    throw new Error('Worker manifest does not match its completed database receipt.')
  await chmod(manifestPath, 0o600)
  const files = workerBackupFiles(downloaded.files)
  let index = 0
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (index < files.length) {
      const file = files[index++]
      const target = join(directory, file.name)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await readObject(capture.prefix + file.name, target)
      if ((await stat(target)).size !== file.byte_size) throw new Error('Worker backup object size does not match.')
      if (sha(await readFile(target)) !== file.sha256) throw new Error('Worker backup object checksum does not match.')
      await chmod(target, 0o600)
    }
  }))
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  await writeFile(join(directory, 'RESTORE.md'),
    'Completed Worker bundle 0038: schema.json, typed rows and attachment bytes are authoritative.\n' +
    'CSV inspection views are omitted. Run ez restore <directory> --database <new.sqlite> --attachments <new-directory>.\n' +
    'The supported restore quarantines the result. Keep it offline until current privacy/authorization evidence is replayed and reviewed.\n', { mode: 0o600 })
  return files.length
}

/** SQL is a quarantined derivative; the original typed capture is archived too. */
export async function prepareWorkerArtifacts({ capture, workDirectory, readObject, onStage = () => {} }) {
  onStage('source_download')
  const source = join(workDirectory, 'worker-source')
  await downloadCompletedCapture({ capture, directory: source, readObject })
  onStage('offline_restore')
  const { restoreBackup } = await import('../packages/cli/dist/backup.js')
  const result = await restoreBackup({
    bundleDirectory: source,
    targetDatabasePath: join(workDirectory, 'verified.sqlite'),
    targetAttachmentDirectory: join(workDirectory, 'verified-attachments'),
  })
  if (result.quarantined !== true) throw new Error('Worker scratch restore must remain quarantined.')
  // Python's SQLite dump preserves SQL types, schema, indexes and triggers. It
  // reads only the verified local database, never a production database file.
  onStage('sql_derivation')
  await execute('python3', ['-c', `import sqlite3,sys,os
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
with open(sys.argv[2], 'x') as out:
 for line in c.iterdump(): out.write(line+'\\n')
c.close()
os.chmod(sys.argv[2],0o600)
`, join(workDirectory, 'verified.sqlite'), join(workDirectory, 'dump.sql')])
  onStage('archive_creation')
  const archive = join(workDirectory, 'worker-bundle.tar.gz')
  await execute('tar', ['-czf', archive, '-C', source, '.'])
  await chmod(archive, 0o600)
  const archiveHash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) archiveHash.update(chunk)
  return {
    capture_kind: 'worker-derived-quarantined',
    source_capture_id: capture.manifest.capture_id,
    source_exported_at: capture.manifest.exported_at,
    source_archive_sha256: archiveHash.digest('hex'),
    source_archive_bytes: (await stat(archive)).size,
    restored_tables: result.tablesRestored,
    restored_rows: result.totalRows,
    restored_attachments: result.attachmentsRestored,
  }
}

async function main() {
  const database = process.env.D1_DATABASE_NAME, bucket = process.env.R2_BUCKET
  if (!safeName.test(database ?? '') || !safeName.test(bucket ?? '')) throw new Error('Invalid backup configuration.')
  for (const output of ['dump.sql', 'worker-bundle.tar.gz', 'worker-source.json']) {
    const existing = await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (existing) throw new Error('Refusing to replace existing local backup artifacts.')
  }
  const workDirectory = resolve(process.env.WORKER_BACKUP_SCRATCH ?? 'worker-backup-scratch')
  await mkdir(workDirectory, { recursive: false, mode: 0o700 })
  // Keep private provider output in memory, never in workflow logs.
  preparationStage = 'completion_lookup'
  const receipt = await wrangler(['d1', 'execute', database, '--remote', '--json', '--command',
    "SELECT id,r2_prefix,manifest_json FROM backup_runs WHERE status='completed' AND trigger='nightly' AND r2_prefix IS NOT NULL ORDER BY started_at DESC,id DESC LIMIT 1"], { maxBuffer: 16 * 1024 * 1024 })
  preparationStage = 'completion_receipt'
  const capture = selectCompletedCapture(JSON.parse(receipt.stdout))
  const result = await prepareWorkerArtifacts({ capture, workDirectory, onStage: stage => { preparationStage = stage },
    readObject: async (key, target) => { await wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', target]) },
  })
  preparationStage = 'local_publication'
  // Existing deposit steps operate in the checkout; only publish finished files.
  await copyFile(join(workDirectory, 'dump.sql'), 'dump.sql', constants.COPYFILE_EXCL)
  await copyFile(join(workDirectory, 'worker-bundle.tar.gz'), 'worker-bundle.tar.gz', constants.COPYFILE_EXCL)
  await writeFile('worker-source.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ verified: true, tables: result.restored_tables, rows: result.restored_rows, attachments: result.restored_attachments }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Provider/SQLite errors can contain private output. Report a bounded stage
    // and exit class, never their message, SQL, arguments or captured stdout.
    const commandExit = Number.isInteger(error?.code) && error.code > 0 && error.code < 256 ? error.code : undefined
    console.error(JSON.stringify({ error: 'worker_backup_preparation_failed', stage: preparationStage, ...(commandExit ? { command_exit: commandExit } : {}), ...(error.safeProviderFailure ? { provider: error.safeProviderFailure } : {}) }))
    process.exitCode = 1
  })
}
