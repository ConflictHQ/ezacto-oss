// `ezacto-migrate auth` — PAT + account discovery + preflight (migration-spec §1).

import { harvestFetch } from './harvest-client.js'
import {
  readManifestIfExists,
  writeManifest,
  type Manifest,
  type ManifestPreflightUser,
} from './manifest.js'
import type { HarvestEnv } from './env.js'

interface HarvestAccount {
  id: number
  name: string
  product: string
}

export interface AuthResult {
  account: { id: string; name: string }
  companyName: string
  isAdministrator: boolean
  manifestDir: string
}

export interface RunAuthOptions {
  env: HarvestEnv
  toolVersion: string
  snapshotDir: string
  accountIdFlag?: string
  /** Allow re-pointing a populated snapshot dir at a different Harvest account. */
  force?: boolean
  /** Injectable clock — tests never depend on a real `now`. */
  now?: () => Date
  log?: (line: string) => void
}

/**
 * The warning AC #4 requires, derived from what the manifest records rather than
 * from a live response. `extract` is a separate CLI invocation whose only
 * inherited state is snapshot/manifest.json (migration-spec §0) and it never
 * calls /v2/users/me (§2.1 order, steps 1–13) — so it raises this same warning
 * from the manifest before its first request.
 */
export const visibilityWarning = (user: ManifestPreflightUser): string | null => {
  if (user.is_administrator) return null
  return (
    `WARNING: visibility limitation — this PAT is not an administrator (access_roles: ${user.access_roles.join(', ')}) — ` +
    "extract will only see this user's own time entries/projects, not the full account"
  )
}

/**
 * Resolves the account, preflights company + user, warns on non-administrator
 * access, and persists the result into snapshot/manifest.json.
 */
export const runAuth = async (options: RunAuthOptions): Promise<AuthResult> => {
  const { env, toolVersion, snapshotDir, accountIdFlag, force } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.log(line))
  const baseUrl = 'https://id.getharvest.com'

  // 1 — account discovery, no Harvest-Account-Id header for this call.
  const accounts = parseAccounts(
    await harvestFetch('/api/v2/accounts', {
      pat: env.pat,
      userAgentEmail: env.userAgentEmail,
      baseUrl,
    }),
  )
  const harvestAccounts = accounts.filter((a) => a.product === 'harvest')

  const resolved = resolveAccount(harvestAccounts, accountIdFlag ?? env.accountId)
  const accountId = String(resolved.id)

  // 2 — company preflight
  const company = parseCompany(
    await harvestFetch('/v2/company', {
      pat: env.pat,
      userAgentEmail: env.userAgentEmail,
      accountId,
    }),
  )

  // 3 — users/me: confirm administrator, warn loudly BEFORE any further side effect.
  const me = parseUserMe(
    await harvestFetch('/v2/users/me', {
      pat: env.pat,
      userAgentEmail: env.userAgentEmail,
      accountId,
    }),
  )

  const warning = visibilityWarning(me)
  if (warning) log(warning)

  // 4 — persist preflight into the snapshot manifest, without destroying what a
  // previous run put there. `resources` (page/cursor progress) and `updated_since`
  // (incremental watermarks) are extract's resume record (migration-spec §2.3/§2.4);
  // re-running `auth` against the same snapshot dir must carry them forward.
  const existing = await readManifestIfExists(snapshotDir)
  const sameAccount = existing?.account?.id === accountId
  if (existing && !sameAccount && !force) {
    throw new Error(
      `snapshot dir ${snapshotDir} already holds account ${existing.account?.id} (${existing.account?.name}), ` +
        `not ${accountId} (${resolved.name}) — its raw/ data belongs to the other account. ` +
        'Use a different --snapshot-dir, or pass --force to re-stamp this one (extract progress for ' +
        'the previous account is discarded).',
    )
  }
  if (existing && !sameAccount) {
    log(
      `WARNING: --force re-stamped ${snapshotDir} from account ${existing.account?.id} to ${accountId} — ` +
        "any raw/ files already in this directory hold the previous account's data; delete them before extract",
    )
  }
  const carried = sameAccount ? existing : null
  const manifest: Manifest = {
    account: { id: accountId, name: resolved.name },
    company_name: company.name,
    started_at: carried?.started_at ?? now().toISOString(),
    finished_at: carried?.finished_at ?? null,
    tool_version: toolVersion,
    preflight: {
      clock: company.clock,
      wants_timestamp_timers: company.wants_timestamp_timers,
      expense_feature: company.expense_feature,
      invoice_feature: company.invoice_feature,
      estimate_feature: company.estimate_feature,
      approval_feature: company.approval_feature,
      user: me,
    },
    resources: carried?.resources ?? {},
    updated_since: carried?.updated_since ?? {},
  }
  await writeManifest(snapshotDir, manifest)

  return {
    account: { id: accountId, name: resolved.name },
    companyName: company.name,
    isAdministrator: me.is_administrator,
    manifestDir: snapshotDir,
  }
}

const resolveAccount = (
  accounts: HarvestAccount[],
  preferredId: string | undefined,
): HarvestAccount => {
  if (accounts.length === 0) {
    throw new Error(
      'no Harvest accounts found for this PAT — check that the token belongs to a Harvest (not Forecast-only) account',
    )
  }
  if (preferredId) {
    const match = accounts.find((a) => String(a.id) === preferredId)
    if (match) return match
    throw new Error(
      `HARVEST_ACCOUNT_ID (or --account-id) is ${preferredId}, but that id is not among this PAT's Harvest accounts: ` +
        accounts.map((a) => `${a.id} (${a.name})`).join(', '),
    )
  }
  if (accounts.length === 1) {
    return accounts[0]
  }
  throw new Error(
    'multiple Harvest accounts are available for this PAT — pick one with --account-id or set HARVEST_ACCOUNT_ID: ' +
      accounts.map((a) => `${a.id} (${a.name})`).join(', '),
  )
}

// --- response validation -----------------------------------------------------
// The preflight is load-bearing: manifest.preflight.clock is what later commands
// use to parse `started_time`/`ended_time` (research §0). An `as` cast over a
// response that lost a field writes a manifest with holes in it and still exits
// 0 — so every field this story persists is checked before it is trusted.

interface CompanyPreflight {
  name: string
  clock: string
  wants_timestamp_timers: boolean
  expense_feature: boolean
  invoice_feature: boolean
  estimate_feature: boolean
  approval_feature: boolean
}

const describe = (value: unknown): string => {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

const badResponse = (endpoint: string, detail: string): Error =>
  new Error(
    `unexpected ${endpoint} response from Harvest — ${detail}. The preflight is load-bearing ` +
      '(manifest.preflight drives how later commands parse this account); refusing to write a manifest from it.',
  )

const asRecord = (raw: unknown, endpoint: string): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badResponse(endpoint, `expected a JSON object, got ${describe(raw)}`)
  }
  return raw as Record<string, unknown>
}

const requireString = (o: Record<string, unknown>, key: string, endpoint: string): string => {
  const value = o[key]
  if (typeof value !== 'string') {
    throw badResponse(endpoint, `"${key}" is ${describe(value)}, expected a string`)
  }
  return value
}

const requireBoolean = (o: Record<string, unknown>, key: string, endpoint: string): boolean => {
  const value = o[key]
  if (typeof value !== 'boolean') {
    throw badResponse(endpoint, `"${key}" is ${describe(value)}, expected a boolean`)
  }
  return value
}

const requireNumber = (o: Record<string, unknown>, key: string, endpoint: string): number => {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badResponse(endpoint, `"${key}" is ${describe(value)}, expected a number`)
  }
  return value
}

const parseAccounts = (raw: unknown): HarvestAccount[] => {
  const endpoint = 'id.getharvest.com/api/v2/accounts'
  const body = asRecord(raw, endpoint)
  const accounts = body.accounts
  if (!Array.isArray(accounts)) {
    throw badResponse(endpoint, `"accounts" is ${describe(accounts)}, expected an array`)
  }
  return accounts.map((entry, i) => {
    const account = asRecord(entry, `${endpoint} accounts[${i}]`)
    return {
      id: requireNumber(account, 'id', `${endpoint} accounts[${i}]`),
      name: requireString(account, 'name', `${endpoint} accounts[${i}]`),
      product: requireString(account, 'product', `${endpoint} accounts[${i}]`),
    }
  })
}

const parseCompany = (raw: unknown): CompanyPreflight => {
  const endpoint = '/v2/company'
  const body = asRecord(raw, endpoint)
  return {
    name: requireString(body, 'name', endpoint),
    clock: requireString(body, 'clock', endpoint),
    wants_timestamp_timers: requireBoolean(body, 'wants_timestamp_timers', endpoint),
    expense_feature: requireBoolean(body, 'expense_feature', endpoint),
    invoice_feature: requireBoolean(body, 'invoice_feature', endpoint),
    estimate_feature: requireBoolean(body, 'estimate_feature', endpoint),
    approval_feature: requireBoolean(body, 'approval_feature', endpoint),
  }
}

const parseUserMe = (raw: unknown): ManifestPreflightUser => {
  const endpoint = '/v2/users/me'
  const body = asRecord(raw, endpoint)
  const roles = body.access_roles
  if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string')) {
    throw badResponse(
      endpoint,
      `"access_roles" is ${describe(roles)}, expected an array of strings`,
    )
  }
  const access_roles = roles as string[]
  return {
    id: requireNumber(body, 'id', endpoint),
    access_roles,
    is_administrator: access_roles.includes('administrator'),
  }
}
