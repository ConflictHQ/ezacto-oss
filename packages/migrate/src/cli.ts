#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadDevVars, readHarvestEnv } from './env.js'
import { runAuth } from './auth.js'

const USAGE = `ezacto-migrate <command> [options]

Commands:
  auth    Authenticate with Harvest, resolve the account, and preflight settings

Options:
  --account-id <id>    Harvest account id to use (skips auto-pick/prompt)
  --snapshot-dir <dir> Snapshot directory to write manifest.json into (default: ./snapshot)
`

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
    },
  })
  const command = positionals[0]

  if (command !== 'auth') {
    process.stdout.write(USAGE)
    return 1
  }

  loadDevVars()
  const env = readHarvestEnv()
  const toolVersion = await readToolVersion()
  const snapshotDir = values['snapshot-dir'] ?? './snapshot'

  const result = await runAuth({
    env,
    toolVersion,
    snapshotDir,
    accountIdFlag: values['account-id'],
  })

  console.log(`account:       ${result.account.name} (${result.account.id})`)
  console.log(`company:       ${result.companyName}`)
  console.log(`administrator: ${result.isAdministrator ? 'yes' : 'no'}`)
  console.log(`manifest:      ${result.manifestDir}/manifest.json`)
  return 0
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`error: ${message}`)
      process.exit(1)
    })
}
