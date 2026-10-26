#!/usr/bin/env node
import { webhookCommand } from './webhooks.js'
import { invoiceEditInput, invoiceTimeSelection } from './invoice-input.js'
import { beginInvoiceSudo, createSudoClients, endInvoiceSudo, readTerminalSecret } from './sudo.js'
import { realpathSync } from 'node:fs'
import { decryptBackupBundle } from './backup-decrypt.js'
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
  type OrganizationConfig,
} from './config.js'
import {
  confidentialityFilteredFetch,
  exportExpenses,
  editInvoice,
  prepareInvoiceEdit,
  resolveInvoice,
  exportTimeEntries,
  generateInvoice,
  listInvoices,
  resolveClientId,
  resolveProjectId,
  resolveProjectIds,
  runReport,
  sendInvoice,
  uninvoiced,
  unlinkTime,
  validReportDefinitions,
  requiredReportScope,
  type MoneyCommandResult,
  type InvoiceEditInput,
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
import { createS3Client, parseS3Destination, s3ConfigFromEnvironment } from './s3.js'
import { syncBundle } from './sync.js'

const USAGE = `ez <command> [options]

Commands:
  login        Validate and store an API token for an organization
  whoami       Show the user and scopes of the stored credential
  config       Show the active organization config with the token redacted
  logout       Remove the stored credential for an organization
  log          Log a duration: ez log 2h northpeak devops -m "note"
  timer        Start, stop, or inspect the one running timer
  week         Show the Monday–Sunday time grid
  uninvoiced   Show uninvoiced amounts (requires reports:read)
  invoice      Generate, send, list, or edit invoices; edits and unlink-time require sudo
  sudo         Reauthenticate for one draft edit: ez sudo invoice edit <number> [options]
  report       List or run reports; report list shows each required scope
  export       Export time entries or expenses as CSV (or --verify a backup bundle)
  webhooks     Show delivery logs or replay a delivery using a session piped on stdin
  backup       Create a full backup bundle from a local database (--sync-to copies it to S3)
  backup-decrypt  Decrypt and verify a downloaded encrypted Worker logical bundle
  restore      Restore a backup bundle into a fresh database

Availability:
  Help and report list are offline inventories, not the connected instance's capabilities.
  Remote commands require the instance module to be enabled and your token to have access.
  A module_disabled response is an operator policy refusal; signing in again cannot enable it.
  Local backup, restore, verification and decryption do not use the server backup module.

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
  --as-of <yyyy-mm-dd>      Receivables aging date
  --status <state>          Invoiced status: draft, open, paid, or closed
  --project-status <state>  Profitability projects: all, active, or archived
  --billing-method <kind>   Profitability billing type
  --manager-id <id>         Profitability project-manager ID
  --tag-id <id>             Profitability project-tag ID
  --task-id <id>            Detailed-time task ID
  --user-id <id>            Detailed-time teammate ID
  --role-id <id>            Detailed-time role ID
  --invoice-state <state>   Detailed time: all, invoiced, or uninvoiced
  --client <name-or-id>     Client filter for reports and invoices
  --project <name-or-id>    Project filter (repeatable for invoice generate)
  --include-fixed-fee       Include hourly value from fixed-fee projects
  --hours <kind>            Detailed time: all, billable, non_billable, or uninvoiced
  --grain <kind>            Detailed time grain: day or entry
  --active-projects-only    Limit detailed time to active projects
  --billable-only           Limit detailed expense to billable expenses
  --event-type <type>       Limit activity log to one event type
  --actor-id <id>           Limit activity log to one actor ID
  --csv                     Emit CSV instead of human-readable output
  --columns <a,b,c>         Export columns, in order (default: every exportable one)
  --time-summary <type>     Time summary type for invoice generate
  --expense-summary <type>  Expense summary type for invoice generate
  --subject <text>          Invoice edit: new subject
  --notes-file <path>       Invoice edit: replace the notes with the contents of a file
  --issue-date <yyyy-mm-dd> Invoice edit: new issue date
  --due-date <yyyy-mm-dd>   Invoice edit: new due date
  --reauth-stdin           Sudo: read JSON email/password and optional authenticator/recovery code from stdin
  --terms <terms>           Invoice edit: upon_receipt, net_15, net_30, net_45, net_60, or custom
  --line <n>                Invoice edit: line to change, counted from 1 in invoice order
  --quantity <n>            Invoice edit: new quantity for --line
  --rate <dollars>          Invoice edit: new unit price for --line, such as 150 or 150.50
  --description <text>      Invoice edit: new description for --line
  --entries <id,id,...>     Invoice unlink-time: time entry IDs to mark uninvoiced
  --database <path>         SQLite database path (or set EZACTO_DATA_DIR)
  --output <path>           Output directory for backup or backup-decrypt
  --attachments <path>      Attachment directory for backup/restore
  --sync-to <s3://bucket/prefix>  Copy the bundle to an S3-compatible bucket after ez backup
                            (credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; optional
                            AWS_SESSION_TOKEN, EZACTO_S3_ENDPOINT, EZACTO_S3_REGION, EZACTO_S3_ADDRESSING)
  --bundle <path>           With --sync-to, sync an existing bundle instead of creating one (resumes)
  --verify                  Verify checksums for ez export --verify
  --json                    Emit machine-readable JSON
  --help                    Show this help
`

export interface CliRuntime {
  environment: NodeJS.ProcessEnv
  stdout(line: string): void
  stderr(line: string): void
  readStdin(): Promise<string>
  readSecret?(prompt: string): Promise<string>
}

const processRuntime = (): CliRuntime => ({
  environment: process.env,
  readSecret: readTerminalSecret,
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

class CliScopeError extends Error {
  readonly code = 'insufficient_scope'
  constructor(readonly required_scope: string, readonly profile: string) {
    const guidance = required_scope === 'reports:read' && !['accounting', 'executive_manager', 'administrator'].includes(profile)
      ? ' Organization reports require accounting, executive_manager, or administrator access. Members can use ez report run my-hours with time_entries:read.'
      : ' Issue a token with this scope if your profile allows it, then run ez login again.'
    super(`The stored token for profile ${profile} lacks the required ${required_scope} scope.${guidance}`)
  }
}

const requireStoredScope = (organization: OrganizationConfig, scope: string): void => {
  if (!organization.scopes.includes(scope)) throw new CliScopeError(scope, organization.profile)
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

interface InvoiceElevationContext {
  credential: string
  invoiceId: number
  version: number
  organizationName: string
  organization: OrganizationConfig
  client: EzactoClient
  edit?: InvoiceEditInput
}
const invoiceClient = (
  selected: { name: string; organization: OrganizationConfig; client: EzactoClient },
  elevation: InvoiceElevationContext | undefined,
): EzactoClient => {
  if (elevation === undefined) return selected.client
  if (
    selected.name !== elevation.organizationName ||
    selected.organization.base_url !== elevation.organization.base_url ||
    selected.organization.token !== elevation.organization.token ||
    selected.organization.user_id !== elevation.organization.user_id
  )
    throw new Error(
      'The stored organization changed during reauthentication. Review the configuration before retrying.',
    )
  return elevation.client
}
const executeCli = async (
  argv: readonly string[],
  runtime: CliRuntime,
  elevation?: InvoiceElevationContext,
): Promise<number> => {
  const { positionals, values, tokens } = parseArgs({
    tokens: true,
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      org: { type: 'string' },
      'base-url': { type: 'string' },
      token: { type: 'string' },
      'token-stdin': { type: 'boolean', default: false },
      'reauth-stdin': { type: 'boolean', default: false },
      config: { type: 'string' },
      message: { type: 'string', short: 'm' },
      date: { type: 'string' },
      week: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'as-of': { type: 'string' },
      status: { type: 'string' },
      'project-status': { type: 'string' },
      'billing-method': { type: 'string' },
      'manager-id': { type: 'string' },
      'tag-id': { type: 'string' },
      'task-id': { type: 'string' },
      'user-id': { type: 'string' },
      'role-id': { type: 'string' },
      'invoice-state': { type: 'string' },
      client: { type: 'string' },
      project: { type: 'string', multiple: true },
      'include-fixed-fee': { type: 'boolean', default: false },
      hours: { type: 'string' },
      grain: { type: 'string' },
      'active-projects-only': { type: 'boolean', default: false },
      'billable-only': { type: 'boolean', default: false },
      'event-type': { type: 'string' },
      'actor-id': { type: 'string' },
      csv: { type: 'boolean', default: false },
      columns: { type: 'string' },
      'time-summary': { type: 'string' },
      'expense-summary': { type: 'string' },
      subject: { type: 'string' },
      'notes-file': { type: 'string' },
      'issue-date': { type: 'string' },
      'due-date': { type: 'string' },
      terms: { type: 'string' },
      line: { type: 'string' },
      quantity: { type: 'string' },
      rate: { type: 'string' },
      description: { type: 'string' },
      entries: { type: 'string' },
      database: { type: 'string' },
      output: { type: 'string' },
      attachments: { type: 'string' },
      'sync-to': { type: 'string' },
      bundle: { type: 'string' },
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
  if (command === 'webhooks') return webhookCommand(commandArguments, runtime)

  if (values.columns !== undefined && command !== 'export') {
    throw new Error('--columns is valid only with ez export')
  }
if (values['reauth-stdin'] && command !== 'sudo')
  throw new Error('--reauth-stdin is valid only with ez sudo')
if (command === 'sudo') {
  if (
    commandArguments.length !== 3 ||
    commandArguments[0] !== 'invoice' ||
    !['edit', 'unlink-time'].includes(commandArguments[1]!)
  )
    throw new Error('usage: ez sudo invoice <edit|unlink-time> <number> [options]')
  const allowed = new Set([
    'org',
    'config',
    'reauth-stdin',
    'json',
    'csv',
    'subject',
    'notes-file',
    'issue-date',
    'due-date',
    'terms',
    'line',
    'quantity',
    'rate',
    'description',
    'entries',
  ])
  for (const token of tokens)
    if (token.kind === 'option' && !allowed.has(token.name))
      throw new Error(`--${token.name} is not valid with ez sudo invoice`)
  const action = commandArguments[1]!,
    number = commandArguments[2]!
  const edit = invoiceEditInput(number, action === 'edit' ? values : {})
  if (action === 'edit') {
    if (values.entries !== undefined) throw new Error('--entries is valid only with unlink-time')
    prepareInvoiceEdit(edit)
  } else {
    if (
      [
        'subject',
        'notes-file',
        'issue-date',
        'due-date',
        'terms',
        'line',
        'quantity',
        'rate',
        'description',
      ].some((key) => values[key as keyof typeof values] !== undefined)
    )
      throw new Error('Invoice content options are valid only with edit')
    invoiceTimeSelection(values.entries)
  }
  const selected = await selectedClient(configPath, values.org)
  for (const scope of [
    'invoices:read',
    'invoices:write',
    ...(action === 'unlink-time' ? ['time_entries:write'] : []),
  ])
    requireStoredScope(selected.organization, scope)
  const clients = createSudoClients(selected.organization)
  const invoice = await resolveInvoice(clients.business, number)
  if (invoice.state !== 'draft')
    throw new Error(`invoice #${invoice.number} is ${invoice.state}; ez sudo edits drafts only`)
  if (
    action === 'edit' &&
    edit.line !== undefined &&
    !invoice.line_items.sort((a, b) => a.position - b.position)[edit.line - 1]
  )
    throw new Error(`invoice #${invoice.number} has no line ${edit.line}`)
  const grant = await beginInvoiceSudo(clients.issuer, invoice.id, runtime, values['reauth-stdin'])
  const omit = new Set(
    tokens
      .filter((token) => token.kind === 'option' && token.name === 'reauth-stdin')
      .map((token) => token.index),
  )
  omit.add(tokens.find((token) => token.kind === 'positional')!.index)
  const child = argv.filter((_arg, index) => !omit.has(index))
  try {
    return await executeCli(child, runtime, {
      credential: grant.credential,
      invoiceId: invoice.id,
      version: invoice.version,
      organizationName: selected.name,
      organization: selected.organization,
      client: clients.business,
      ...(action === 'edit' ? { edit } : {}),
    })
  } finally {
    await endInvoiceSudo(clients.issuer, grant, runtime)
  }
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

  const reportFilterOptions =
    values['include-fixed-fee'] ||
    values.hours !== undefined ||
    values.grain !== undefined ||
    values['active-projects-only'] ||
    values['billable-only'] ||
    values['event-type'] !== undefined ||
    values['actor-id'] !== undefined ||
    values.status !== undefined

  const moneyOptions =
    values.from !== undefined ||
    values.to !== undefined ||
    values['as-of'] !== undefined ||
    values.client !== undefined ||
    (values.project !== undefined && values.project.length > 0) ||
    values.csv ||
    values['time-summary'] !== undefined ||
    values['expense-summary'] !== undefined ||
    reportFilterOptions

  if (reportFilterOptions && command !== 'report') {
    throw new Error('report filter options are valid only with ez report run')
  }

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
    requireStoredScope(selected.organization, 'reports:read')
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
    const editOptions =
      values.subject !== undefined || values['notes-file'] !== undefined ||
      values['issue-date'] !== undefined || values['due-date'] !== undefined || values.terms !== undefined ||
      values.line !== undefined || values.quantity !== undefined ||
      values.rate !== undefined || values.description !== undefined
    if (editOptions && action !== 'edit') {
      throw new Error('--subject, --notes-file, --issue-date, --due-date, --terms, --line, --quantity, --rate, and --description are valid only with ez invoice edit')
    }
    if (values.entries !== undefined && action !== 'unlink-time') {
      throw new Error('--entries is valid only with ez invoice unlink-time')
    }

    if (action === 'edit') {
      if (commandArguments.length !== 2) {
        throw new Error('usage: ez invoice edit <number> [--subject s] [--notes-file path] [--issue-date d] [--terms t] [--line n --quantity q --rate r --description d]')
      }
      const edit = elevation?.edit ?? invoiceEditInput(commandArguments[1]!, values)
      const selected = await selectedClient(configPath, values.org)
      requireStoredScope(selected.organization, 'invoices:write')
      return printMoneyResult(
        await editInvoice(invoiceClient(selected, elevation), {
          ...edit,
          ...(elevation === undefined ? {} : {elevationCredential:elevation.credential,expectedVersion:elevation.version,expectedInvoiceId:elevation.invoiceId}),
        }),
        values.json,
        values.csv,
        runtime,
      )
    }

    if (action === 'unlink-time') {
      if (commandArguments.length !== 2) throw new Error('usage: ez invoice unlink-time <number> --entries <id,id,...>')
      const entryIds = invoiceTimeSelection(values.entries)
      const selected = await selectedClient(configPath, values.org)
      for (const scope of ['invoices:read', 'time_entries:write', 'invoices:write']) {
        requireStoredScope(selected.organization, scope)
      }
      return printMoneyResult(
        await unlinkTime(invoiceClient(selected, elevation), {number:commandArguments[1]!,entryIds,...(elevation===undefined?{}:{elevationCredential:elevation.credential,expectedVersion:elevation.version,expectedInvoiceId:elevation.invoiceId})}),
        values.json,
        values.csv,
        runtime,
      )
    }

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
        throw new Error('usage: ez invoice <generate|send|list|edit|unlink-time>')
      }
      const selected = await selectedClient(configPath, values.org)
      return printMoneyResult(
        await listInvoices(selected.client),
        values.json,
        values.csv,
        runtime,
      )
    }

    throw new Error('usage: ez invoice <generate|send|list|edit|unlink-time>')
  }

  if (command === 'report') {
    if (values.message !== undefined || values.date !== undefined || values.week !== undefined) {
      throw new Error('time options are not valid with ez report')
    }
    const action = commandArguments[0]
    if (action === 'list') {
      if (commandArguments.length !== 1) throw new Error('usage: ez report list')
      if (reportFilterOptions) {
        throw new Error('report filter options are valid only with ez report run')
      }
      return printMoneyResult(
        {
          json: validReportDefinitions(),
          human: validReportDefinitions().map((definition) => `${definition} (requires ${requiredReportScope(definition)})`).join('\n'),
          csv: ['report', ...validReportDefinitions()].join('\n'),
        },
        values.json,
        values.csv,
        runtime,
      )
    }
    if (action !== 'run') {
      throw new Error(`usage: ez report <list|run <${validReportDefinitions().join('|')}>>`)
    }
    const definition = commandArguments[1]
    if (definition === undefined) {
      throw new Error(`usage: ez report run <${validReportDefinitions().join('|')}>`)
    }
    if (commandArguments.length > 2) {
      throw new Error('ez report run accepts no additional positional arguments')
    }
    const requiredScope = requiredReportScope(definition)
    if (definition === 'receivables' && values['as-of'] === undefined) {
      throw new Error('receivables report requires --as-of')
    }
    if (definition !== 'receivables' && values['as-of'] !== undefined) {
      throw new Error('--as-of is valid only with the receivables report')
    }
    const range = definition === 'receivables'
      ? { from: values['as-of']!, to: values['as-of']! }
      : requireRange()
    const selected = await selectedClient(configPath, values.org)
    requireStoredScope(selected.organization, requiredScope)
    const clientId = values.client !== undefined
      ? await resolveClientId(selected.client, values.client)
      : undefined
    const projectId = values.project !== undefined && values.project.length > 0
      ? await resolveProjectId(selected.client, values.project[0]!)
      : undefined
    const hours = values.hours
    if (
      hours !== undefined &&
      hours !== 'all' &&
      hours !== 'billable' &&
      hours !== 'non_billable' &&
      hours !== 'uninvoiced'
    ) {
      throw new Error('--hours must be all, billable, non_billable, or uninvoiced')
    }
    const grain = values.grain
    if (grain !== undefined && grain !== 'day' && grain !== 'entry') {
      throw new Error('--grain must be day or entry')
    }
    const actorId = values['actor-id'] === undefined
      ? undefined
      : Number(values['actor-id'])
    if (actorId !== undefined && (!Number.isSafeInteger(actorId) || actorId <= 0)) {
      throw new Error('--actor-id must be a positive integer')
    }
    const managerId = values['manager-id'] === undefined
      ? undefined
      : Number(values['manager-id'])
    const tagId = values['tag-id'] === undefined ? undefined : Number(values['tag-id'])
    const taskId = values['task-id'] === undefined ? undefined : Number(values['task-id'])
    const userId = values['user-id'] === undefined ? undefined : Number(values['user-id'])
    const roleId = values['role-id'] === undefined ? undefined : Number(values['role-id'])
    for (const [name, value] of [
      ['manager-id', managerId], ['tag-id', tagId], ['task-id', taskId],
      ['user-id', userId], ['role-id', roleId],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`--${name} must be a positive integer`)
      }
    }
    const projectStatus = values['project-status']
    if (
      projectStatus !== undefined &&
      projectStatus !== 'all' &&
      projectStatus !== 'active' &&
      projectStatus !== 'archived'
    ) throw new Error('--project-status must be all, active, or archived')
    const billingMethod = values['billing-method']
    if (
      billingMethod !== undefined &&
      billingMethod !== 'non_billable' &&
      billingMethod !== 'time_materials' &&
      billingMethod !== 'fixed_fee'
    ) throw new Error('--billing-method must be non_billable, time_materials, or fixed_fee')
    if (
      definition !== 'profitability' &&
      [projectStatus, billingMethod, managerId].some((value) => value !== undefined)
    ) throw new Error('profitability filters are valid only with the profitability report')
    const invoiceState = values['invoice-state']
    if (
      invoiceState !== undefined && invoiceState !== 'all' &&
      invoiceState !== 'invoiced' && invoiceState !== 'uninvoiced'
    ) throw new Error('--invoice-state must be all, invoiced, or uninvoiced')
    if (
      definition !== 'detailed-time' &&
      [taskId, userId, roleId, invoiceState].some((value) => value !== undefined)
    ) throw new Error('detailed-time filters are valid only with the detailed-time report')
    if (tagId !== undefined && definition !== 'profitability' && definition !== 'detailed-time') {
      throw new Error('--tag-id is valid only with profitability or detailed-time')
    }
    const invoiceStatus = values.status
    if (
      invoiceStatus !== undefined &&
      invoiceStatus !== 'draft' &&
      invoiceStatus !== 'open' &&
      invoiceStatus !== 'paid' &&
      invoiceStatus !== 'closed'
    ) {
      throw new Error('--status must be draft, open, paid, or closed')
    }
    if (invoiceStatus !== undefined && definition !== 'invoiced') {
      throw new Error('--status is valid only with the invoiced report')
    }
    return printMoneyResult(
      await runReport(selected.client, {
        definition,
        ...range,
        ...(clientId === undefined ? {} : { clientId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(values['include-fixed-fee'] ? { includeFixedFee: true } : {}),
        ...(hours === undefined ? {} : { hours }),
        ...(grain === undefined ? {} : { grain }),
        ...(values['active-projects-only'] ? { activeProjectsOnly: true } : {}),
        ...(values['billable-only'] ? { billableOnly: true } : {}),
        ...(values['event-type'] === undefined ? {} : { eventType: values['event-type'] }),
        ...(actorId === undefined ? {} : { actorId }),
        ...(values['as-of'] === undefined ? {} : { asOf: values['as-of'] }),
        ...(invoiceStatus === undefined ? {} : { invoiceStatus }),
        ...(projectStatus === undefined ? {} : { projectStatus }),
        ...(billingMethod === undefined ? {} : { billingMethod }),
        ...(managerId === undefined ? {} : { managerId }),
        ...(tagId === undefined ? {} : { tagId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(userId === undefined ? {} : { userId }),
        ...(roleId === undefined ? {} : { roleId }),
        ...(invoiceState === undefined ? {} : { invoiceState }),
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

  if ((values['sync-to'] !== undefined || values.bundle !== undefined) && command !== 'backup') {
    throw new Error('--sync-to and --bundle are valid only with ez backup')
  }

  if (command === 'backup-decrypt') {
    if (commandArguments.length !== 1 || values.output === undefined)
      throw new Error('usage: ez backup-decrypt <encrypted-run-directory> --output <new-directory>; set EZACTO_BACKUP_ENCRYPTION_KEY in the environment')
    const result = await decryptBackupBundle({inputDirectory:commandArguments[0]!,outputDirectory:values.output,
      encodedKey:runtime.environment.EZACTO_BACKUP_ENCRYPTION_KEY??''})
    runtime.stdout(values.json?json(result):`Decrypted and verified ${result.tableCount} tables: ${result.outputDirectory}. This is a Worker logical bundle; see RESTORE.md for recovery limits.`)
    return 0
  }


  if (command === 'backup') {
    if (commandArguments.length !== 0) throw new Error('ez backup accepts no positional arguments')
    if (values.verify) throw new Error('--verify is valid only with ez export')
    if (values.bundle !== undefined && values['sync-to'] === undefined) {
      throw new Error('--bundle needs --sync-to: it names an existing bundle to copy off-platform')
    }
    const syncTo = async (bundleDirectory: string) => {
      const { bucket, prefix } = parseS3Destination(values['sync-to']!)
      runtime.stderr(
        'warning: the bundle is sent as is, not encrypted; it carries password hashes and authenticator seeds, so use a private bucket with server-side encryption',
      )
      const synced = await syncBundle(bundleDirectory, {
        client: createS3Client(s3ConfigFromEnvironment(runtime.environment)),
        bucket,
        prefix,
      })
      const destination = `s3://${bucket}/${[prefix, synced.bundleName].filter((part) => part !== '').join('/')}`
      return {
        json: {
          destination,
          objects: synced.objects.length,
          uploaded: synced.uploaded,
          already_present: synced.skipped,
          bytes_uploaded: synced.uploadedBytes,
        },
        lines: [
          `synced to ${destination}`,
          `objects: ${synced.objects.length}, uploaded: ${synced.uploaded}, already present: ${synced.skipped}, bytes uploaded: ${synced.uploadedBytes}`,
        ],
      }
    }
    if (values.bundle !== undefined) {
      const synced = await syncTo(values.bundle)
      runtime.stdout(values.json ? json({ bundle: values.bundle, sync: synced.json }) : synced.lines.join('\n'))
      return 0
    }
    const databasePath = resolveDatabase()
    const attachmentDirectory = resolveAttachments()
    const outputDirectory = values.output ?? process.cwd()
    const result = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory,
    })
    // Sync before reporting success: a backup that was asked to leave the
    // machine and did not is a failed command, and the thrown error says why.
    const synced = values['sync-to'] === undefined ? undefined : await syncTo(result.bundleDirectory)
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
            ...(synced === undefined ? {} : { sync: synced.json }),
          })
        : [
            `backup created: ${result.bundleDirectory}`,
            `tables: ${tableCount}, rows: ${totalRows}, attachments: ${attachmentCount}`,
            `database sha256: ${result.manifest.database_sha256}`,
            ...(synced === undefined ? [] : synced.lines),
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
            ...(result.quarantined ? { quarantined: true } : {}),
            tables: result.tablesRestored,
            rows: result.totalRows,
            attachments: result.attachmentsRestored,
          })
        : [
            `restore complete: ${targetDatabasePath}`,
            ...(result.quarantined ? ['QUARANTINED: keep this database offline. Replay current privacy evidence and record reviewed release before starting service.'] : []),
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

interface CliErrorDetails {
  readonly message: string
  readonly code?: string
  readonly status?: number
  readonly request_id?: string
  readonly required_scope?: string
  readonly profile?: string
}

const errorDetails = (error: unknown): CliErrorDetails => {
  if (error instanceof CliScopeError) {
    return { message: error.message, code: error.code, required_scope: error.required_scope, profile: error.profile }
  }
  if (error instanceof EzactoApiError) {
    const body = error.body !== null && typeof error.body === 'object'
      ? Reflect.get(error.body, 'error') as unknown : undefined
    const detail = body !== null && typeof body === 'object' ? body : {}
    const code: unknown = Reflect.get(detail, 'code')
    const message: unknown = Reflect.get(detail, 'message')
    const fields: unknown = Reflect.get(detail, 'fields')
    const fieldMessages = Array.isArray(fields)
      ? fields.flatMap((field: unknown) => {
          const text: unknown = field !== null && typeof field === 'object'
            ? Reflect.get(field, 'message') : undefined
          return typeof text === 'string' && text.trim() !== '' ? [text.trim()] : []
        })
      : []
    return {
      message: error.status === 401
        ? 'authentication failed: the API token is invalid or revoked'
        : code === 'invoice_version_conflict'
          ? 'the invoice changed since it was read; run the command again'
          : fieldMessages.length > 0
            ? fieldMessages.join(' ')
            : typeof message === 'string' && message.trim() !== '' ? message : 'ezacto API request failed',
      ...(typeof code === 'string' ? { code } : {}),
      status: error.status,
      ...(typeof error.requestId === 'string' ? { request_id: error.requestId } : {}),
    }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

const errorMessage = (error: unknown): string => {
  const details = errorDetails(error)
  if (details.status === undefined) return details.message
  const context = [String(details.status), details.code, details.request_id === undefined ? undefined : `request ${details.request_id}`]
    .filter((part) => part !== undefined).join(', ')
  return `${details.message} (${context})`
}

export const runCli = (argv:readonly string[],runtime:CliRuntime=processRuntime()):Promise<number>=>executeCli([...argv],runtime)

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
        process.stderr.write(`${json({ error: errorDetails(error) })}\n`)
      } else {
        process.stderr.write(`error: ${message}\n`)
      }
      process.exitCode = 1
    })
}

export { USAGE, errorMessage }
