// `ezacto-migrate auth` — PAT + account discovery + preflight (migration-spec §1).

import { harvestFetch } from './harvest-client.js'
import { describe } from './response.js'
import {
  COMPANY_SETTING_KEYS,
  readManifestIfExists,
  writeManifest,
  type Manifest,
  type ManifestCompanySettings,
  type ManifestPreflight,
  type ManifestPreflightUser,
} from './manifest.js'
import type { HarvestEnv } from './env.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'
import { sanitizePriorBinaries } from './binaries.js'

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
 * The warning AC #4 requires. `extract` is a separate CLI invocation that re-reads
 * HARVEST_PAT from the environment, so it re-runs this check against its own live
 * /v2/users/me rather than trusting the identity the manifest records: the two are
 * only the same token until someone rotates one.
 */
export const visibilityWarning = (user: ManifestPreflightUser): string | null => {
  if (user.is_administrator) return null
  return (
    `WARNING: visibility limitation — this PAT is not an administrator (access_roles: ${user.access_roles.join(', ')}) — ` +
    "extract will only see this user's own time entries/projects, not the full account"
  )
}

/**
 * Describes an identity change between two preflights, or null when the snapshot
 * is still being written by the same user at the same access level. Both halves
 * matter: a different `id` sees a different slice of the account, and the same id
 * demoted from administrator stops seeing most of it.
 */
export const scopeChangeBetween = (
  previous: ManifestPreflightUser,
  next: ManifestPreflightUser,
): string | null => {
  if (previous.id !== next.id) {
    return `authenticating user was ${previous.id}, is now ${next.id}`
  }
  if (previous.is_administrator !== next.is_administrator) {
    const was = previous.is_administrator ? 'administrator' : 'member-scoped'
    const now = next.is_administrator ? 'administrator' : 'member-scoped'
    return `user ${next.id} was ${was}, is now ${now} (access_roles: ${next.access_roles.join(', ')})`
  }
  return null
}

/** `field: old -> new` for every company setting that changed between two runs. */
export const settingsDrift = (
  previous: ManifestCompanySettings,
  next: ManifestCompanySettings,
): string[] =>
  COMPANY_SETTING_KEYS.filter((key) => previous[key] !== next[key]).map(
    (key) => `${key}: ${String(previous[key])} -> ${String(next[key])}`,
  )

/**
 * Resolves the account, preflights company + user, warns on non-administrator
 * access, and persists the result into snapshot/manifest.json.
 */
export const runAuth = async (options: RunAuthOptions): Promise<AuthResult> => {
  const { env, toolVersion, snapshotDir, accountIdFlag, force } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.log(line))
  const lockPath = await acquireSnapshotLock(snapshotDir, 'auth')
  try {
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
  const safeExistingBinaries = await sanitizePriorBinaries(snapshotDir, existing?.binaries)
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
  const preflight: ManifestPreflight = { ...company.settings, user: me }

  // 5 — the account matching is not enough: a snapshot's rows are only ever what
  // the authenticating PAT could see. Re-stamping carried progress with a
  // different user's preflight would leave a manifest that describes visibility
  // the raw/ files were never gathered under — the one delta reconcile cannot
  // explain afterwards (migration-spec §6).
  if (carried) {
    const scopeChange = scopeChangeBetween(carried.preflight.user, me)
    const carriedProgress = Object.keys(carried.resources).length > 0
    if (scopeChange && carriedProgress && !force) {
      throw new Error(
        `snapshot dir ${snapshotDir} holds extract progress gathered as a different identity — ${scopeChange}. ` +
          "Its raw/ files show that user's visibility, so re-stamping them with this preflight would " +
          'misdescribe them. Use a different --snapshot-dir, or pass --force to overwrite the preflight ' +
          '(the existing raw/ data keeps the old visibility and must be re-extracted).',
      )
    }
    if (scopeChange) {
      log(`WARNING: preflight identity changed — ${scopeChange}`)
    }
    const drift = settingsDrift(carried.preflight, preflight)
    if (drift.length > 0) {
      log(
        `WARNING: company settings changed since this snapshot was stamped (${drift.join(', ')}) — ` +
          'rows already in raw/ were extracted under the previous settings',
      )
    }
  }
  // Same-account auth is also a manifest rewrite. Never carry nested binary
  // runtime data through it until every record has been rebuilt from verified
  // on-disk content and every anomaly has been reduced to stable scalars.
  const carriedBinaries = carried ? safeExistingBinaries : undefined

  const manifest: Manifest = {
    account: { id: accountId, name: resolved.name },
    company_name: company.name,
    started_at: carried?.started_at ?? now().toISOString(),
    finished_at: carried?.finished_at ?? null,
    tool_version: toolVersion,
    preflight,
    resources: carried?.resources ?? {},
    updated_since: carried?.updated_since ?? {},
    // Sync tombstones are scoped to this account just as extract progress is.
    // Preserve them when rotating/re-running auth for the same account, but do
    // not carry one account's deletion decisions across a forced re-stamp.
    ...(carried?.deleted_upstream ? { deleted_upstream: carried.deleted_upstream } : {}),
    ...(carried?.full_id_sweeps ? { full_id_sweeps: carried.full_id_sweeps } : {}),
    ...(carriedBinaries ? { binaries: carriedBinaries } : {}),
  }
  await writeManifest(snapshotDir, manifest)

  return {
    account: { id: accountId, name: resolved.name },
    companyName: company.name,
    isAdministrator: me.is_administrator,
    manifestDir: snapshotDir,
  }
  } finally {
    await releaseSnapshotLock(lockPath)
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
  settings: ManifestCompanySettings
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

const optionalBoolean = (
  o: Record<string, unknown>,
  key: string,
  endpoint: string,
): boolean | 'unknown' => {
  const value = o[key]
  if (value === undefined) return 'unknown'
  if (typeof value !== 'boolean') {
    throw badResponse(endpoint, `"${key}" is ${describe(value)}, expected a boolean when present`)
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
    settings: {
      // The invoice archive is served from Harvest's client-facing web origin,
      // not api.harvestapp.com. Capture its non-secret account location here so
      // archive never has to repeat the expensive company preflight.
      base_uri: requireString(body, 'base_uri', endpoint),
      full_domain: requireString(body, 'full_domain', endpoint),
      clock: requireString(body, 'clock', endpoint),
      wants_timestamp_timers: requireBoolean(body, 'wants_timestamp_timers', endpoint),
      expense_feature: requireBoolean(body, 'expense_feature', endpoint),
      invoice_feature: requireBoolean(body, 'invoice_feature', endpoint),
      estimate_feature: requireBoolean(body, 'estimate_feature', endpoint),
      approval_feature: requireBoolean(body, 'approval_feature', endpoint),
      // Documented by Harvest, but absent from older/live Company responses.
      // Unknown is intentional: extract probes the optional teammates endpoint
      // parent-by-parent and records refusals instead of treating absence as off.
      team_feature: optionalBoolean(body, 'team_feature', endpoint),
      // Harvest's Company endpoint exposes neither the organization address nor
      // its default currency. Null is evidence, not a guessed USD/default value;
      // load requires an explicit override unless one unique client currency can
      // prove the latter from the snapshot.
      organization_currency: null,
      organization_address: null,
      // Display settings: not parse inputs, but the `organization` row is built
      // from them at load, and re-fetching means re-running the rate-limited step.
      week_start_day: requireString(body, 'week_start_day', endpoint),
      time_format: requireString(body, 'time_format', endpoint),
      date_format: requireString(body, 'date_format', endpoint),
      currency_code_display: requireString(body, 'currency_code_display', endpoint),
      currency_symbol_display: requireString(body, 'currency_symbol_display', endpoint),
      decimal_symbol: requireString(body, 'decimal_symbol', endpoint),
      thousands_separator: requireString(body, 'thousands_separator', endpoint),
      weekly_capacity: requireNumber(body, 'weekly_capacity', endpoint),
    },
  }
}

/** Validates a /v2/users/me body into the preflight identity. Shared with extract. */
export const parseUserMe = (raw: unknown): ManifestPreflightUser => {
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
