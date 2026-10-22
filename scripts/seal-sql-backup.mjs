// Add counts from a real private scratch restore before publishing a SQL manifest.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { runDrill } from './restore-drill.mjs'
export async function sealSqlBackup({ dumpPath, manifestPath }) {
  const result = await runDrill({ dumpPath, manifestPath, productInvariants: true })
  if (result.status !== 'pass' || !result.scratch_removed)
    throw new Error('SQL backup scratch verification failed')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.row_counts = result.counts.per_table
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  return { tables: result.counts.tables, rows: result.counts.rows }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dumpPath, manifestPath] = process.argv.slice(2)
  sealSqlBackup({ dumpPath, manifestPath })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      process.stderr.write(
        'SQL backup manifest verification failed; the latest retained-backup pointer was not updated.\n',
      )
      process.exitCode = 1
    })
}
