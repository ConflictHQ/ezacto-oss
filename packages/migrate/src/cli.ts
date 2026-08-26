#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadDevVars, readHarvestEnv } from './env.js'
import { runAuth } from './auth.js'
import { runExtract, type ExtractResult } from './extract.js'

const USAGE = `ezacto-migrate <command> [options]

Commands:
  auth     Authenticate with Harvest, resolve the account, and preflight settings
  extract  Sweep the account into the snapshot dir (run auth first; resumable)

Options:
  --account-id <id>    Harvest account id to use (skips auto-pick/prompt)
  --snapshot-dir <dir> Snapshot directory to write manifest.json into (default: ./snapshot)
  --force              Re-stamp a snapshot dir that holds a different account
`

/**
 * The per-resource counts table §2.2 asks extract to leave behind — the thing a
 * Harvest UI spot-check is compared against. Skipped steps print too: a resource
 * that is absent because a feature is off has to be distinguishable from one that
 * silently came back empty.
 */
export const formatCounts = (result: ExtractResult, manifestPath: string): string => {
  const names = Object.keys(result.resources)
  const width = Math.max(...names.map((n) => n.length), 8)
  const lines = names.map((name) => {
    const r = result.resources[name]
    const note = r.skipped_reason ? `  skipped: ${r.skipped_reason}` : ''
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

const main = async (): Promise<number> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'account-id': { type: 'string' },
      'snapshot-dir': { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  const command = positionals[0]

  if (command !== 'auth' && command !== 'extract') {
    process.stdout.write(USAGE)
    return 1
  }

  const devVarsPath = loadDevVars()
  const env = readHarvestEnv(devVarsPath)
  const snapshotDir = values['snapshot-dir'] ?? './snapshot'

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

  const result = await runExtract({ env, snapshotDir })
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
