#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { EzactoApiError, EzactoClient, type Whoami } from '@conflict-hq/ezacto-client'
import {
  CLI_CONFIG_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_ORGANIZATION,
  assertApiToken,
  assertOrganizationName,
  normalizeBaseUrl,
  readConfig,
  removeConfig,
  resolveConfigPath,
  selectOrganization,
  tokenHint,
  writeConfig,
  type CliConfig,
} from './config.js'
import {
  confidentialityFilteredFetch,
  exportExpenses,
  exportTimeEntries,
  generateInvoice,
  listInvoices,
  resolveClientId,
  resolveProjectId,
  resolveProjectIds,
  runReport,
  sendInvoice,
  uninvoiced,
  validReportDefinitions,
  type MoneyCommandResult,
} from './money.js'
import {
  logTime,
  showWeek,
  startTimer,
  stopTimer,
  timerStatus,
  type TimeCommandResult,
} from './time.js'
import { createBackup, restoreBackup, verifyBackup } from './backup.js'

const USAGE = `ez <command> [options]

Commands:
  login        Validate and store an API token for an organization
  whoami       Show the user and scopes of the stored credential
  config       Show the active organization config with the token redacted
  logout       Remove the stored credential for an organization
  log          Log a duration: ez log 2h northpeak devops -m "note"
  timer        Start, stop, or inspect the one running timer
  week         Show the Monday–Sunday time grid
  uninvoiced   Show uninvoiced amounts for a date range
  invoice      Generate, send, or list invoices
  report       Run a report definition (uninvoiced, client-rollup, project-budget)
  export       Export time entries or expenses as CSV (or --verify a backup bundle)
  backup       Create a full backup bundle from a local database
  restore      Restore a backup bundle into a fresh database

Options:
  --org <name>              Organization config name (default: active or "default")
  --base-url <url>          ezacto API origin for login (default: https://ezacto.io)
  --token <token>           API token to store; prefer --token-stdin or EZACTO_TOKEN
  --token-stdin             Read the API token from stdin
  --config <path>           Override the config file (or set EZACTO_CONFIG)
  --message, -m <text>      Notes for ez log or ez timer start
  --date <yyyy-mm-dd>       Spent date for ez log or ez timer start (default: today)
  --week <yyyy-mm-dd>       A date in the week to show (default: today)
  --from <yyyy-mm-dd>       Start date for reports and exports
  --to <yyyy-mm-dd>         End date for reports and exports
  --client <name-or-id>     Client filter for reports and invoices
  --project <name-or-id>    Project filter (repeatable for invoice generate)
  --csv                     Emit CSV instead of human-readable output
  --columns <a,b,c>         Export columns, in order (default: every exportable one)
  --time-summary <type>     Time summary type for invoice generate
  --expense-summary <type>  Expense summary type for invoice generate
  --database <path>         SQLite database path (or set EZACTO_DATA_DIR)
  --output <path>           Output directory for ez backup (default: current directory)
  --attachments <path>      Attachment directory for backup/restore
  --verify                  Verify checksums for ez export --verify
  --json                    Emit machine-readable JSON
  --help                    Show this help
`

export interface CliRuntime {
  environment: NodeJS.ProcessEnv
  stdout(line: string): void
  stderr(line: string): void
  readStdin(): Promise<string>
}

const processRuntime = (): CliRuntime => ({
  environment: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readStdin: async () => {
    let value = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) value += chunk
    return value
  },
})

const json = (value: unknown): string => JSON.stringify(value, null, 2)

const identityOutput = (
  organization: string,
  baseUrl: string,
  identity: Whoami,
) => ({
  organization,
  base_url: baseUrl,
  user_id: identity.user_id,
  profile: identity.profile,
  manager_grants: [...identity.manager_grants],
  authentication: identity.authentication,
})

/**
 * Every client the CLI builds reads the API through the confidentiality filter,
 * so a field the export enumeration marks confidential is gone before any
 * rendering can reach it. One door: redacting per verb is how #310's leak
 * survived in `ez report run` and `ez week` after `ez export` was closed.
 */
const clientFor = (credential: { base_url: string; token: string }): EzactoClient =>
  new EzactoClient({
    baseUrl: credential.base_url,
    token: credential.token,
    fetch: confidentialityFilteredFetch(),
  })

const requireConfig = async (path: string): Promise<CliConfig> => {
  const config = await readConfig(path)
  if (config === null) throw new Error(`not logged in; run ez login (config: ${path})`)
  return config
}

const selectedClient = async (configPath: string, org?: string) => {
  const selected = selectOrganization(await requireConfig(configPath), org)
  return { ...selected, client: clientFor(selected.organization) }
}

const printTimeResult = (
  result: TimeCommandResult,
  machineReadable: boolean,
  runtime: CliRuntime,
): number => {
  runtime.stdout(machineReadable ? json(result.json) : result.human)
  return 0
}

const printMoneyResult = (
  result: MoneyCommandResult,
  machineReadable: boolean,
  csvMode: boolean,
  runtime: CliRuntime,
): number => {
  if (machineReadable) {
    runtime.stdout(json(result.json))
  } else if (csvMode && result.csv !== undefined) {
    runtime.stdout(result.csv)
  } else {
    runtime.stdout(result.human)
  }
  return 0
}

const login = async (
  options: {
    org?: string
    baseUrl?: string
    token?: string
    tokenStdin: boolean
    configPath: string
    json: boolean
  },
  runtime: CliRuntime,
): Promise<number> => {
  if (options.tokenStdin && options.token !== undefined) {
    throw new Error('choose exactly one of --token and --token-stdin')
  }
  const suppliedToken = options.tokenStdin
    ? await runtime.readStdin()
    : (options.token ?? runtime.environment.EZACTO_TOKEN)
  if (suppliedToken === undefined || suppliedToken.trim() === '') {
    throw new Error('provide an API token with --token-stdin, --token, or EZACTO_TOKEN')
  }
  const token = assertApiToken(suppliedToken)
  const existing = await readConfig(options.configPath)
  const name = assertOrganizationName(
    options.org ?? existing?.active_organization ?? DEFAULT_ORGANIZATION,
  )
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ??
      runtime.environment.EZACTO_URL ??
      existing?.organizations[name]?.base_url ??
      DEFAULT_BASE_URL,
  )
  const identity = (
    await clientFor({ base_url: baseUrl, token }).getWhoami()
  ).data
  if (identity.authentication.kind !== 'token') {
    throw new Error('login validation did not resolve an API-token credential')
  }

  const organizations = { ...(existing?.organizations ?? {}) }
  organizations[name] = {
    base_url: baseUrl,
    token,
    user_id: identity.user_id,
    profile: identity.profile,
    scopes: [...identity.authentication.scopes],
  }
  await writeConfig(options.configPath, {
    version: CLI_CONFIG_VERSION,
    active_organization: name,
    organizations,
  })

  const output = identityOutput(name, baseUrl, identity)
  runtime.stdout(
    options.json
      ? json(output)
      : `logged in: ${name} — user ${identity.user_id} (${identity.profile}) at ${baseUrl}`,
  )
  return 0
}

const whoami = async (
  options: { org?: string; configPath: string; json: boolean },
  runtime: CliRuntime,
): Promise<number> => {
  const selected = selectOrganization(
    await requireConfig(options.configPath),
    options.org,
  )
  const identity = (await clientFor(selected.organization).getWhoami()).data
  const output = identityOutput(
    selected.name,
    selected.organization.base_url,
    identity,
  )
  runtime.stdout(
    options.json
      ? json(output)
      : [
          `organization: ${selected.name}`,
          `server:       ${selected.organization.base_url}`,
          `user:         ${identity.user_id}`,
          `profile:      ${identity.profile}`,
          `auth:         ${identity.authentication.kind}`,
          `scopes:       ${
            identity.authentication.kind === 'token'
              ? identity.authentication.scopes.join(', ')
              : 'session authority'
          }`,
        ].join('\n'),
  )
  return 0
}

const showConfig = async (
  options: { org?: string; configPath: string; json: boolean },
  runtime: CliRuntime,
): Promise<number> => {
  const config = await requireConfig(options.configPath)
  const selected = selectOrganization(config, options.org)
  const output = {
    config: options.configPath,
    active: selected.name === config.active_organization,
    organization: selected.name,
    base_url: selected.organization.base_url,
    user_id: selected.organization.user_id,
    profile: selected.organization.profile,
    scopes: [...selected.organization.scopes],
    token_hint: tokenHint(selected.organization.token),
  }
  runtime.stdout(
    options.json
      ? json(output)
      : [
          `config:       ${options.configPath}`,
          `organization: ${selected.name}${output.active ? ' (active)' : ''}`,
          `server:       ${selected.organization.base_url}`,
          `user:         ${selected.organization.user_id} (${selected.organization.profile})`,
          `token:        ${output.token_hint}`,
        ].join('\n'),
  )
  return 0
}

const logout = async (
  options: { org?: string; configPath: string; json: boolean },
  runtime: CliRuntime,
): Promise<number> => {
  const config = await requireConfig(options.configPath)
  const selected = selectOrganization(config, options.org)
  const organizations = { ...config.organizations }
  delete organizations[selected.name]
  const remaining = Object.keys(organizations).sort()
  if (remaining.length === 0) {
    await removeConfig(options.configPath)
  } else {
    await writeConfig(options.configPath, {
      version: CLI_CONFIG_VERSION,
      active_organization:
        config.active_organization === selected.name
          ? remaining[0]!
          : config.active_organization,
      organizations,
    })
  }
  runtime.stdout(
    options.json
      ? json({ logged_out: true, organization: selected.name })
      : `logged out: ${selected.name}`,
  )
  return 0
}

export const runCli = async (
  argv: readonly string[],
  runtime: CliRuntime = processRuntime(),
): Promise<number> => {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      org: { type: 'string' },
      'base-url': { type: 'string' },
      token: { type: 'string' },
      'token-stdin': { type: 'boolean', default: false },
      config: { type: 'string' },
      message: { type: 'string', short: 'm' },
      date: { type: 'string' },
      week: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      client: { type: 'string' },
      project: { type: 'string', multiple: true },
      csv: { type: 'boolean', default: false },
      columns: { type: 'string' },
      'time-summary': { type: 'string' },
      'expense-summary': { type: 'string' },
      database: { type: 'string' },
      output: { type: 'string' },
      attachments: { type: 'string' },
      verify: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help || positionals.length === 0) {
    runtime.stdout(USAGE.trimEnd())
    return values.help ? 0 : 1
  }
  const command = positionals[0]
  const commandArguments = positionals.slice(1)
  const configPath = values.config ?? resolveConfigPath(runtime.environment)
  const options = {
    ...(values.org === undefined ? {} : { org: values.org }),
    configPath,
    json: values.json,
  }

  if (command === 'login') {
    if (commandArguments.length !== 0) throw new Error('ez login accepts no positional arguments')
    return login(
      {
        ...options,
        ...(values['base-url'] === undefined
          ? {}
          : { baseUrl: values['base-url'] }),
        ...(values.token === undefined ? {} : { token: values.token }),
        tokenStdin: values['token-stdin'],
      },
      runtime,
    )
  }
  if (values['base-url'] !== undefined || values.token !== undefined || values['token-stdin']) {
    throw new Error('--base-url and token options are valid only with ez login')
  }
  if (values.columns !== undefined && command !== 'export') {
    throw new Error('--columns is valid only with ez export')
  }
  if (command === 'log') {
    if (commandArguments.length !== 3) {
      throw new Error('usage: ez log <duration> <project> <task> [-m note] [--date yyyy-mm-dd]')
    }
    if (values.week !== undefined) throw new Error('--week is valid only with ez week')
    const selected = await selectedClient(configPath, values.org)
    return printTimeResult(
      await logTime(selected.client, {
        duration: commandArguments[0]!,
        project: commandArguments[1]!,
        task: commandArguments[2]!,
        ...(values.date === undefined ? {} : { date: values.date }),
        ...(values.message === undefined ? {} : { message: values.message }),
      }),
      values.json,
      runtime,
    )
  }
  if (command === 'timer') {
    const action = commandArguments[0]
    const selected = await selectedClient(configPath, values.org)
    if (action === 'start') {
      if (commandArguments.length !== 3) {
        throw new Error('usage: ez timer start <project> <task> [-m note] [--date yyyy-mm-dd]')
      }
      if (values.week !== undefined) throw new Error('--week is valid only with ez week')
      return printTimeResult(
        await startTimer(selected.client, {
          project: commandArguments[1]!,
          task: commandArguments[2]!,
          ...(values.date === undefined ? {} : { date: values.date }),
          ...(values.message === undefined ? {} : { message: values.message }),
        }),
        values.json,
        runtime,
      )
    }
    if (action !== 'stop' && action !== 'status') {
      throw new Error('usage: ez timer <start|stop|status>')
    }
    if (commandArguments.length !== 1) {
      throw new Error(`ez timer ${action} accepts no additional arguments`)
    }
    if (values.message !== undefined || values.date !== undefined || values.week !== undefined) {
      throw new Error(`message/date/week options are not valid with ez timer ${action}`)
    }
    return printTimeResult(
      await (action === 'stop' ? stopTimer(selected.client) : timerStatus(selected.client)),
      values.json,
      runtime,
    )
  }
  if (command === 'week') {
    if (commandArguments.length !== 0) throw new Error('ez week accepts no positional arguments')
    if (values.message !== undefined || values.date !== undefined) {
      throw new Error('--message and --date are not valid with ez week')
    }
    const selected = await selectedClient(configPath, values.org)
    return printTimeResult(
      await showWeek(selected.client, {
        ...(values.week === undefined ? {} : { within: values.week }),
      }),
      values.json,
      runtime,
    )
  }
  // --- money options guard for time commands ---------------------------------

  const moneyOptions =
    values.from !== undefined ||
    values.to !== undefined ||
    values.client !== undefined ||
    (values.project !== undefined && values.project.length > 0) ||
    values.csv ||
    values['time-summary'] !== undefined ||
    values['expense-summary'] !== undefined

  // --- money / report commands -----------------------------------------------

  const requireRange = (): { from: string; to: string } => {
    if (values.from === undefined || values.to === undefined) {
      throw new Error('--from and --to are required')
    }
    return { from: values.from, to: values.to }
  }

  if (command === 'uninvoiced') {
    if (commandArguments.length !== 0) throw new Error('ez uninvoiced accepts no positional arguments')
    if (values.message !== undefined || values.date !== undefined || values.week !== undefined) {
      throw new Error('time options are not valid with ez uninvoiced')
    }
    const range = requireRange()
    const selected = await selectedClient(configPath, values.org)
    const clientId = values.client !== undefined
      ? await resolveClientId(selected.client, values.client)
      : undefined
    const projectId = values.project !== undefined && values.project.length > 0
      ? await resolveProjectId(selected.client, values.project[0]!)
      : undefined
    return printMoneyResult(
      await uninvoiced(selected.client, {
        ...range,
        ...(clientId === undefined ? {} : { clientId }),
        ...(projectId === undefined ? {} : { projectId }),
      }),
      values.json,
      values.csv,
      runtime,
    )
  }

  if (command === 'invoice') {
    if (values.message !== undefined || values.date !== undefined || values.week !== undefined) {
      throw new Error('time options are not valid with ez invoice')
    }
    const action = commandArguments[0]

    if (action === 'generate') {
      if (commandArguments.length !== 1) throw new Error('ez invoice generate accepts no additional positional arguments')
      const range = requireRange()
      if (values.client === undefined) throw new Error('ez invoice generate requires --client')
      if (values.project === undefined || values.project.length === 0) {
        throw new Error('ez invoice generate requires at least one --project')
      }
      const selected = await selectedClient(configPath, values.org)
      const clientId = await resolveClientId(selected.client, values.client)
      const projectIds = await resolveProjectIds(selected.client, values.project)
      return printMoneyResult(
        await generateInvoice(selected.client, {
          clientId,
          ...range,
          projectIds,
          ...(values['time-summary'] === undefined ? {} : { timeSummaryType: values['time-summary'] }),
          ...(values['expense-summary'] === undefined ? {} : { expenseSummaryType: values['expense-summary'] }),
        }),
        values.json,
        values.csv,
        runtime,
      )
    }

    if (action === 'send') {
      if (commandArguments.length !== 2) throw new Error('usage: ez invoice send <id>')
      const invoiceId = Number(commandArguments[1])
      if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) {
        throw new Error(`invalid invoice id: ${commandArguments[1]}`)
      }
      const selected = await selectedClient(configPath, values.org)
      return printMoneyResult(
        await sendInvoice(selected.client, { invoiceId }),
        values.json,
        values.csv,
        runtime,
      )
    }

    if (action === 'list' || action === undefined) {
      if (action !== undefined && commandArguments.length !== 1) {
        throw new Error('ez invoice list accepts no additional positional arguments')
      }
      if (action === undefined && commandArguments.length !== 0) {
        throw new Error('usage: ez invoice <generate|send|list>')
      }
      const selected = await selectedClient(configPath, values.org)
      return printMoneyResult(
        await listInvoices(selected.client),
        values.json,
        values.csv,
        runtime,
      )
    }

    throw new Error('usage: ez invoice <generate|send|list>')
  }

  if (command === 'report') {
    if (values.message !== undefined || values.date !== undefined || values.week !== undefined) {
      throw new Error('time options are not valid with ez report')
    }
    const action = commandArguments[0]
    if (action !== 'run') {
      throw new Error(`usage: ez report run <${validReportDefinitions().join('|')}>`)
    }
    const definition = commandArguments[1]
    if (definition === undefined) {
      throw new Error(`usage: ez report run <${validReportDefinitions().join('|')}>`)
    }
    if (commandArguments.length > 2) {
      throw new Error('ez report run accepts no additional positional arguments')
    }
    const range = requireRange()
    const selected = await selectedClient(configPath, values.org)
    const clientId = values.client !== undefined
      ? await resolveClientId(selected.client, values.client)
      : undefined
    const projectId = values.project !== undefined && values.project.length > 0
      ? await resolveProjectId(selected.client, values.project[0]!)
      : undefined
    return printMoneyResult(
      await runReport(selected.client, {
        definition,
        ...range,
        ...(clientId === undefined ? {} : { clientId }),
        ...(projectId === undefined ? {} : { projectId }),
      }),
      values.json,
      values.csv,
      runtime,
    )
  }

  if (command === 'export') {
    if (values.message !== undefined || values.date !== undefined || values.week !== undefined) {
      throw new Error('time options are not valid with ez export')
    }
    const kind = commandArguments[0]
    if (kind !== 'time' && kind !== 'expenses') {
      throw new Error('usage: ez export <time|expenses> --from date --to date')
    }
    if (commandArguments.length !== 1) {
      throw new Error('ez export accepts no additional positional arguments after the kind')
    }
    const range = requireRange()
    const selected = await selectedClient(configPath, values.org)
    const clientId = values.client !== undefined
      ? await resolveClientId(selected.client, values.client)
      : undefined
    const projectId = values.project !== undefined && values.project.length > 0
      ? await resolveProjectId(selected.client, values.project[0]!)
      : undefined
    const exportInput = {
      ...range,
      ...(clientId === undefined ? {} : { clientId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(values.columns === undefined ? {} : { columns: values.columns }),
    }
    const result = kind === 'time'
      ? await exportTimeEntries(selected.client, exportInput)
      : await exportExpenses(selected.client, exportInput)
    return printMoneyResult(result, values.json, values.csv, runtime)
  }

  // --- non-money commands (meta/auth) ----------------------------------------

  if (values.message !== undefined || values.date !== undefined || values.week !== undefined) {
    throw new Error('message/date/week options are valid only with time commands')
  }
  if (moneyOptions) {
    throw new Error('--from/--to/--client/--project/--csv/--time-summary/--expense-summary are valid only with money commands')
  }

  const resolveDatabase = (): string => {
    if (values.database !== undefined) return values.database
    const dataDir = runtime.environment.EZACTO_DATA_DIR
    if (dataDir !== undefined) return `${dataDir}/db.sqlite`
    throw new Error('provide --database or set EZACTO_DATA_DIR')
  }

  const resolveAttachments = (): string | undefined => {
    if (values.attachments !== undefined) return values.attachments
    const dataDir = runtime.environment.EZACTO_DATA_DIR
    if (dataDir !== undefined) return `${dataDir}/attachments`
    return undefined
  }

  if (command === 'backup') {
    if (commandArguments.length !== 0) throw new Error('ez backup accepts no positional arguments')
    if (values.verify) throw new Error('--verify is valid only with ez export')
    const databasePath = resolveDatabase()
    const attachmentDirectory = resolveAttachments()
    const outputDirectory = values.output ?? process.cwd()
    const result = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory,
    })
    const tableCount = result.manifest.tables.length
    const totalRows = result.manifest.tables.reduce((sum, table) => sum + table.row_count, 0)
    const attachmentCount = result.manifest.attachments.length
    runtime.stdout(
      values.json
        ? json({
            bundle: result.bundleDirectory,
            manifest: result.manifestPath,
            tables: tableCount,
            rows: totalRows,
            attachments: attachmentCount,
            database_sha256: result.manifest.database_sha256,
          })
        : [
            `backup created: ${result.bundleDirectory}`,
            `tables: ${tableCount}, rows: ${totalRows}, attachments: ${attachmentCount}`,
            `database sha256: ${result.manifest.database_sha256}`,
          ].join('\n'),
    )
    return 0
  }

  if (command === 'restore') {
    if (commandArguments.length !== 1) {
      throw new Error('usage: ez restore <bundle-path> --database <target.sqlite>')
    }
    if (values.verify) throw new Error('--verify is valid only with ez export')
    const bundleDirectory = commandArguments[0]!
    const targetDatabasePath = resolveDatabase()
    const targetAttachmentDirectory = resolveAttachments()
    const result = await restoreBackup({
      bundleDirectory,
      targetDatabasePath,
      targetAttachmentDirectory,
    })
    runtime.stdout(
      values.json
        ? json({
            restored: true,
            tables: result.tablesRestored,
            rows: result.totalRows,
            attachments: result.attachmentsRestored,
          })
        : [
            `restore complete: ${targetDatabasePath}`,
            `tables: ${result.tablesRestored}, rows: ${result.totalRows}, attachments: ${result.attachmentsRestored}`,
          ].join('\n'),
    )
    return 0
  }

  if (command === 'export') {
    if (values.verify) {
      if (commandArguments.length !== 1) {
        throw new Error('usage: ez export --verify <bundle-path>')
      }
      const bundleDirectory = commandArguments[0]!
      const result = await verifyBackup(bundleDirectory)
      if (values.json) {
        runtime.stdout(json(result))
      } else {
        const tableOk = result.tableChecksums.filter((table) => table.valid).length
        const tableTotal = result.tableChecksums.length
        const attachmentOk = result.attachmentChecksums.filter((a) => a.valid).length
        const attachmentTotal = result.attachmentChecksums.length
        const lines = [
          `verification: ${result.valid ? 'PASSED' : 'FAILED'}`,
          `database checksum: ${result.databaseChecksumValid ? 'ok' : 'MISMATCH'}`,
          `table checksums: ${tableOk}/${tableTotal} ok`,
          `attachment checksums: ${attachmentOk}/${attachmentTotal} ok`,
        ]
        if (result.errors.length > 0) {
          lines.push('', 'errors:')
          for (const error of result.errors) lines.push(`  - ${error}`)
        }
        runtime.stdout(lines.join('\n'))
      }
      return result.valid ? 0 : 1
    }
  }
  if (commandArguments.length !== 0) throw new Error(`${command} accepts no positional arguments`)
  if (command === 'whoami') return whoami(options, runtime)
  if (command === 'config') return showConfig(options, runtime)
  if (command === 'logout') return logout(options, runtime)
  throw new Error(`unknown command: ${command}`)
}

const errorMessage = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    if (error.status === 401) return 'authentication failed: the API token is invalid or revoked'
    return `ezacto API request failed (${error.status}, request ${error.requestId ?? 'unknown'})`
  }
  return error instanceof Error ? error.message : String(error)
}

const isMain = ((): boolean => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      const message = errorMessage(error)
      if (process.argv.includes('--json')) {
        process.stderr.write(`${json({ error: { message } })}\n`)
      } else {
        process.stderr.write(`error: ${message}\n`)
      }
      process.exitCode = 1
    })
}

export { USAGE }
