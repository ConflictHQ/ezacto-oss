// Loads .dev.vars (if present) into process.env, then resolves the Harvest
// credentials this CLI needs. .dev.vars lives at the repo root (workspace root),
// two levels up from packages/migrate.

export interface HarvestEnv {
  pat: string
  accountId: string | undefined
  userAgentEmail: string
}

const DEV_VARS_PATH = new URL('../../../.dev.vars', import.meta.url)

export const loadDevVars = (): void => {
  try {
    process.loadEnvFile(DEV_VARS_PATH)
  } catch {
    // .dev.vars is optional (e.g. CI, or vars already set in the shell) — ignore.
  }
}

export const readHarvestEnv = (): HarvestEnv => {
  const pat = process.env.HARVEST_PAT
  if (!pat) {
    throw new Error(
      'HARVEST_PAT is not set — set HARVEST_PAT in .dev.vars (get one from Harvest ID > Developers)',
    )
  }
  return {
    pat,
    accountId: process.env.HARVEST_ACCOUNT_ID || undefined,
    userAgentEmail: process.env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
  }
}
