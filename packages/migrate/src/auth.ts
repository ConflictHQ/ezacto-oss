// `ezacto-migrate auth` — PAT + account discovery + preflight (migration-spec §1).

import { harvestFetch } from './harvest-client.js'
import { writeManifest, type Manifest } from './manifest.js'
import type { HarvestEnv } from './env.js'

interface HarvestAccount {
  id: number
  name: string
  product: string
}

interface AccountsResponse {
  user: { id: number; first_name: string; last_name: string; email: string }
  accounts: HarvestAccount[]
}

interface CompanyResponse {
  name: string
  clock: string
  wants_timestamp_timers: boolean
  expense_feature: boolean
  invoice_feature: boolean
  estimate_feature: boolean
  approval_feature: boolean
}

interface UserMeResponse {
  id: number
  access_roles: string[]
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
  log?: (line: string) => void
}

/**
 * Resolves the account, preflights company + user, warns on non-administrator
 * access, and persists the result into snapshot/manifest.json.
 */
export const runAuth = async (options: RunAuthOptions): Promise<AuthResult> => {
  const { env, toolVersion, snapshotDir, accountIdFlag } = options
  const log = options.log ?? ((line: string) => console.log(line))
  const baseUrl = 'https://id.getharvest.com'

  // 1 — account discovery, no Harvest-Account-Id header for this call.
  const accountsResponse = (await harvestFetch('/api/v2/accounts', {
    pat: env.pat,
    userAgentEmail: env.userAgentEmail,
    baseUrl,
  })) as AccountsResponse
  const harvestAccounts = accountsResponse.accounts.filter((a) => a.product === 'harvest')

  const resolved = resolveAccount(harvestAccounts, accountIdFlag ?? env.accountId)
  const accountId = String(resolved.id)

  // 2 — company preflight
  const company = (await harvestFetch('/v2/company', {
    pat: env.pat,
    userAgentEmail: env.userAgentEmail,
    accountId,
  })) as CompanyResponse

  // 3 — users/me: confirm administrator, warn loudly BEFORE any further side effect.
  const me = (await harvestFetch('/v2/users/me', {
    pat: env.pat,
    userAgentEmail: env.userAgentEmail,
    accountId,
  })) as UserMeResponse

  const isAdministrator = me.access_roles.includes('administrator')
  if (!isAdministrator) {
    log(
      `WARNING: visibility limitation — this PAT is not an administrator (access_roles: ${me.access_roles.join(', ')}) — ` +
        "extract will only see this user's own time entries/projects, not the full account",
    )
  }

  // 4 — persist preflight into the snapshot manifest.
  const startedAt = new Date().toISOString()
  const manifest: Manifest = {
    account: { id: accountId, name: resolved.name },
    company_name: company.name,
    started_at: startedAt,
    finished_at: null,
    tool_version: toolVersion,
    preflight: {
      clock: company.clock,
      wants_timestamp_timers: company.wants_timestamp_timers,
      expense_feature: company.expense_feature,
      invoice_feature: company.invoice_feature,
      estimate_feature: company.estimate_feature,
      approval_feature: company.approval_feature,
    },
    resources: {},
    updated_since: {},
  }
  await writeManifest(snapshotDir, manifest)

  return {
    account: { id: accountId, name: resolved.name },
    companyName: company.name,
    isAdministrator,
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
