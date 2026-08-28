#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { EzactoApiError, EzactoClient, type Whoami } from '@ezacto/client'
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

const USAGE = `ez <command> [options]

Commands:
  login    Validate and store an API token for an organization
  whoami   Show the user and scopes of the stored credential
  config   Show the active organization config with the token redacted
  logout   Remove the stored credential for an organization

Options:
  --org <name>        Organization config name (default: active or "default")
  --base-url <url>    ezacto API origin for login (default: https://ezacto.io)
  --token <token>     API token to store; prefer --token-stdin or EZACTO_TOKEN
  --token-stdin       Read the API token from stdin
  --config <path>     Override the config file (or set EZACTO_CONFIG)
  --json              Emit machine-readable JSON
  --help              Show this help
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

const clientFor = (organization: OrganizationConfig): EzactoClient =>
  new EzactoClient({
    baseUrl: organization.base_url,
    token: organization.token,
  })

const requireConfig = async (path: string): Promise<CliConfig> => {
  const config = await readConfig(path)
  if (config === null) throw new Error(`not logged in; run ez login (config: ${path})`)
  return config
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
    await new EzactoClient({ baseUrl, token }).getWhoami()
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
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help || positionals.length === 0) {
    runtime.stdout(USAGE.trimEnd())
    return values.help ? 0 : 1
  }
  if (positionals.length !== 1) throw new Error('expected exactly one command')
  const command = positionals[0]
  const configPath = values.config ?? resolveConfigPath(runtime.environment)
  const options = {
    ...(values.org === undefined ? {} : { org: values.org }),
    configPath,
    json: values.json,
  }

  if (command === 'login')
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
  if (values['base-url'] !== undefined || values.token !== undefined || values['token-stdin']) {
    throw new Error('--base-url and token options are valid only with ez login')
  }
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
