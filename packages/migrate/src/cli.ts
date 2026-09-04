#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadDevVars, readHarvestEnv } from './env.js'
import { runAuth } from './auth.js'
import { runExtract, type ExtractResult } from './extract.js'
import { runLoad } from './load.js'
import { reconciliationExitCode, runReconcile } from './reconcile.js'
import { runSync, syncExitCode } from './sync.js'
import { runVerify } from './verify.js'
import {
  applyRecurringInvoiceWorksheet,
  applyRetainerWorksheet,
  generateRecurringInvoiceWorksheet,
  generateRetainerWorksheet,
} from './worksheets.js'

const USAGE = `ezacto-migrate <command> [options]

Commands:
  auth     Authenticate with Harvest, resolve the account, and preflight settings
  extract  Sweep the account into the snapshot dir (run auth first). A re-run
           resumes an interrupted resource from its last checkpoint rather than
           re-sweeping it, and refreshes an already-complete one with only the
           rows Harvest reports changed since its last watermark.
  sync     Run an incremental extract, then a complete full-ID delete witness.
  verify   Check snapshot counts/FKs and capture report checksums per currency
  load     Transform a verified snapshot into an ezacto SQLite database
  reconcile Compare Harvest checksums, snapshot rows, and the loaded database
  finish-retainers Generate or apply the missing Harvest retainer-balance worksheet
  finish-recurring-invoices Generate or apply the missing recurring-invoice worksheet

Options:
  --account-id <id>    Harvest account id to use (skips auto-pick/prompt)
  --snapshot-dir <dir> Snapshot directory to write manifest.json into (default: ./snapshot)
  --database <path>    SQLite database path for load/reconcile (required)
  --input <path>       Completed worksheet JSON to apply (finish-* only)
  --organization-currency <code>  ISO currency when Company/client data is ambiguous
  --organization-address <text>   Organization address (Company API omits it)
  --force              Re-stamp a snapshot dir that holds a different account
  --request-timeout <s> Seconds to allow one request, headers and body (default: 10).
                       Raise it when a page of 2000 rows will not finish in time.
`

/**
 * The per-resource counts table §2.2 asks extract to leave behind — the thing a
 * Harvest UI spot-check is compared against. Skipped steps print too: a resource
 * that is absent because a feature is off has to be distinguishable from one that
 * silently came back empty.
 *
 * So do the two ways a row count can be short of the account: a sweep that ended
 * before Harvest's own `total_entries` — the collection's for a full sweep, the
 * filtered query's for an `updated_since` pass — and child parents that vanished
 * mid-run. Without them a truncated resource prints as a perfectly ordinary number.
 */
export const formatCounts = (result: ExtractResult, manifestPath: string): string => {
  const names = Object.keys(result.resources)
  const width = Math.max(...names.map((n) => n.length), 8)
  const lines = names.map((name) => {
    const r = result.resources[name]
    const notes: string[] = []
    // Which witness is comparable depends on what this record describes, exactly
    // as it does in extract. `total_entries` is the last *full* sweep's tally; an
    // incremental pass merges rows into the file `count` describes and never
    // re-tallies the collection, so comparing the two after one printed a Harvest
    // discrepancy for every resource with any activity — and a table that cries
    // wolf on every row is how a real shortfall stops being visible.
    if (r.incremental) {
      if (r.staged_total_entries !== null && r.staged_total_entries !== r.staged_count) {
        notes.push(
          `Harvest reported ${r.staged_total_entries} changed, this pass staged ${r.staged_count}`,
        )
      }
    } else if (r.total_entries !== null && r.total_entries !== r.count) {
      notes.push(`Harvest reported ${r.total_entries}`)
    }
    if (r.missing_parents > 0) notes.push(`${r.missing_parents} parents missing`)
    if (r.skipped_reason) notes.push(`skipped: ${r.skipped_reason}`)
    const note = notes.length > 0 ? `  ${notes.join('; ')}` : ''
    return `${name.padEnd(width)}  ${String(r.count).padStart(7)} rows  ${String(r.pages).padStart(4)} pages${note}`
  })
  const rows = names.reduce((sum, name) => sum + result.resources[name].count, 0)
  lines.push('')
  lines.push(
    `total: ${rows} rows, ${result.requests} requests, ${Math.round(result.durationMs / 1000)}s`,
  )
  lines.push(`manifest: ${manifestPath}`)
  return lines.join('\n')
}

const readToolVersion = async (): Promise<string> => {
  const pkgPath = new URL('../package.json', import.meta.url)
  const raw = await readFile(pkgPath, 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

/**
 * `--request-timeout` in seconds. A page of 2000 time entries carries fully
 * embedded user_assignment and task_assignment objects (research §15.4), so the
 * ten-second default is generous on a fast link and tight on a slow one — and
 * without a way to raise it the only remedy for a too-slow page is not running
 * extract at all.
 */
const parseRequestTimeout = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--request-timeout must be a positive number of seconds, got "${raw}"`)
  }
  return Math.round(seconds * 1000)
}

const main = async (): Promise<number> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'account-id': { type: 'string' },
      'snapshot-dir': { type: 'string' },
      'request-timeout': { type: 'string' },
      database: { type: 'string' },
      input: { type: 'string' },
      'organization-currency': { type: 'string' },
      'organization-address': { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  const command = positionals[0]

  if (
    command !== 'auth' &&
    command !== 'extract' &&
    command !== 'verify' &&
    command !== 'sync' &&
    command !== 'load' &&
    command !== 'reconcile' &&
    command !== 'finish-retainers' &&
    command !== 'finish-recurring-invoices'
  ) {
    process.stdout.write(USAGE)
    return 1
  }

  const snapshotDir = values['snapshot-dir'] ?? './snapshot'
  const timeoutMs = parseRequestTimeout(values['request-timeout'])

  if (command === 'load') {
    if (!values.database) throw new Error('--database is required for load')
    const result = await runLoad({
      snapshotDir,
      databasePath: values.database,
      organizationCurrency: values['organization-currency'],
      organizationAddress: values['organization-address'],
    })
    console.log(
      `loaded: ${result.loadedRows} row(s), ${result.invocations} chunk(s), ` +
        `${result.anomalies.length} anomaly(s); snapshot ${result.snapshotSha256}`,
    )
    return 0
  }

  if (command === 'reconcile') {
    if (!values.database) throw new Error('--database is required for reconcile')
    const result = await runReconcile({
      snapshotDir,
      databasePath: values.database,
    })
    console.log(
      `reconciled: ${result.report.summary.unexplained} UNEXPLAINED delta(s); ` +
        `${result.jsonPath}; ${result.markdownPath}`,
    )
    return reconciliationExitCode(result.report)
  }

  if (command === 'finish-retainers' || command === 'finish-recurring-invoices') {
    if (!values.database) throw new Error(`--database is required for ${command}`)
    const options = { snapshotDir, databasePath: values.database }
    if (values.input === undefined) {
      const worksheet =
        command === 'finish-retainers'
          ? await generateRetainerWorksheet(options)
          : await generateRecurringInvoiceWorksheet(options)
      process.stdout.write(`${JSON.stringify(worksheet, null, 2)}\n`)
      return 0
    }
    const result =
      command === 'finish-retainers'
        ? await applyRetainerWorksheet({ ...options, inputPath: values.input })
        : await applyRecurringInvoiceWorksheet({ ...options, inputPath: values.input })
    console.log(
      `finished: ${result.completed} completed, ${result.replayed} replayed, ` +
        `${result.pending} pending; snapshot ${result.snapshotSha256}`,
    )
    return result.pending === 0 ? 0 : 1
  }

  const devVarsPath = loadDevVars()
  const env = readHarvestEnv(devVarsPath)

  if (command === 'auth') {
    const result = await runAuth({
      env,
      toolVersion: await readToolVersion(),
      snapshotDir,
      accountIdFlag: values['account-id'],
      force: values.force,
    })

    console.log(`account:       ${result.account.name} (${result.account.id})`)
    console.log(`company:       ${result.companyName}`)
    console.log(`administrator: ${result.isAdministrator ? 'yes' : 'no'}`)
    console.log(`manifest:      ${result.manifestDir}/manifest.json`)
    return 0
  }

  if (command === 'verify') {
    const result = await runVerify({ env, snapshotDir, timeoutMs })
    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        console.error(`${issue.kind}: ${issue.path} id=${String(issue.id)} — ${issue.message}`)
      }
      return 1
    }
    console.log(
      `verified: snapshot internally consistent; ${result.checksums.requests} report requests; ` +
        `${snapshotDir}/checksums.json`,
    )
    return 0
  }

  if (command === 'sync') {
    const result = await runSync({ env, snapshotDir, timeoutMs })
    console.log(formatCounts(result.extract, `${snapshotDir}/manifest.json`))
    console.log(
      `sync: ${result.deleted} deletion mark(s) added, ${result.restored} cleared; ` +
        `${result.requests} requests total`,
    )
    if (Object.keys(result.unsupported).length > 0) {
      console.log(
        `sync: deletion coverage unsupported for ${Object.entries(result.unsupported)
          .map(([resource, reason]) => `${resource} (${reason})`)
          .join(', ')}`,
      )
    }
    if (!result.complete) {
      console.error(
        `sync incomplete: no safe deletion decision for ${Object.entries(result.unwitnessed)
          .map(([resource, reason]) => `${resource} (${reason})`)
          .join(', ')}`,
      )
      return syncExitCode(result)
    }
    return 0
  }

  const result = await runExtract({ env, snapshotDir, timeoutMs })
  console.log(formatCounts(result, `${snapshotDir}/manifest.json`))
  return 0
}

// npm installs `bin` entries as symlinks (node_modules/.bin, npm link, npx) and
// Node leaves argv[1] as the symlink path while resolving import.meta.url to the
// realpath — compare realpaths, or the installed CLI is a silent no-op.
const isMain = ((): boolean => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`error: ${message}`)
      process.exit(1)
    })
}
