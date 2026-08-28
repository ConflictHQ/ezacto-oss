import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const CLI_CONFIG_VERSION = 1 as const
export const DEFAULT_ORGANIZATION = 'default'
export const DEFAULT_BASE_URL = 'https://ezacto.io'

const profiles = new Set([
  'member',
  'project_manager',
  'people_admin',
  'accounting',
  'executive_manager',
  'administrator',
])
const tokenPattern = /^ezacto_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/
const organizationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface OrganizationConfig {
  base_url: string
  token: string
  user_id: number
  profile: string
  scopes: string[]
}

export interface CliConfig {
  version: typeof CLI_CONFIG_VERSION
  active_organization: string
  organizations: Record<string, OrganizationConfig>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const normalizeBaseUrl = (raw: string): string => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid ezacto base URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('ezacto base URL must use https')
  }
  const local = new Set(['localhost', '127.0.0.1', '[::1]']).has(url.hostname)
  if (url.protocol === 'http:' && !local) {
    throw new Error('ezacto base URL must use https unless it is localhost')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('ezacto base URL must not contain credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('ezacto base URL must not contain a query or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export const assertOrganizationName = (name: string): string => {
  if (!organizationPattern.test(name)) {
    throw new Error('organization must contain 1–64 letters, digits, dots, dashes, or underscores')
  }
  return name
}

export const assertApiToken = (token: string): string => {
  const trimmed = token.trim()
  if (!tokenPattern.test(trimmed)) {
    throw new Error('API token is not a canonical ezacto token')
  }
  return trimmed
}

const parseOrganization = (name: string, value: unknown): OrganizationConfig => {
  assertOrganizationName(name)
  if (!isObject(value)) throw new Error(`config organization ${name} must be an object`)
  if (
    typeof value.base_url !== 'string' ||
    typeof value.token !== 'string' ||
    !Number.isSafeInteger(value.user_id) ||
    (value.user_id as number) < 1 ||
    typeof value.profile !== 'string' ||
    !profiles.has(value.profile) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === 'string')
  ) {
    throw new Error(`config organization ${name} is malformed`)
  }
  return {
    base_url: normalizeBaseUrl(value.base_url),
    token: assertApiToken(value.token),
    user_id: value.user_id as number,
    profile: value.profile,
    scopes: [...value.scopes],
  }
}

export const parseConfig = (value: unknown): CliConfig => {
  if (!isObject(value) || value.version !== CLI_CONFIG_VERSION) {
    throw new Error(`ezacto CLI config must have version ${CLI_CONFIG_VERSION}`)
  }
  if (typeof value.active_organization !== 'string' || !isObject(value.organizations)) {
    throw new Error('ezacto CLI config is malformed')
  }
  const organizations = Object.fromEntries(
    Object.entries(value.organizations).map(([name, entry]) => [
      name,
      parseOrganization(name, entry),
    ]),
  )
  if (!Object.hasOwn(organizations, value.active_organization)) {
    throw new Error('active organization is not present in ezacto CLI config')
  }
  return {
    version: CLI_CONFIG_VERSION,
    active_organization: value.active_organization,
    organizations,
  }
}

export const resolveConfigPath = (
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string => {
  if (environment.EZACTO_CONFIG !== undefined) return resolve(environment.EZACTO_CONFIG)
  const root = environment.XDG_CONFIG_HOME ?? join(userHome, '.config')
  return join(root, 'ezacto', 'config.json')
}

export const readConfig = async (path: string): Promise<CliConfig | null> => {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    return parseConfig(JSON.parse(raw) as unknown)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read ${path}: ${message}`, { cause: error })
  }
}

export const writeConfig = async (path: string, config: CliConfig): Promise<void> => {
  const canonical = parseConfig(config)
  const directory = dirname(path)
  const directoryExists = await stat(directory).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // `--config /some/existing/directory/file` must never chmod the caller's
  // directory. A directory created specifically for the config is private.
  if (!directoryExists) await chmod(directory, 0o700)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export const removeConfig = async (path: string): Promise<void> => {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export const selectOrganization = (
  config: CliConfig,
  requested?: string,
): { name: string; organization: OrganizationConfig } => {
  const name = assertOrganizationName(requested ?? config.active_organization)
  const organization = config.organizations[name]
  if (organization === undefined) {
    throw new Error(`organization ${name} is not configured; run ez login --org ${name}`)
  }
  return { name, organization }
}

export const tokenHint = (token: string): string =>
  token.replace(/^((?:[^_]+_){2}).+$/, '$1…')
