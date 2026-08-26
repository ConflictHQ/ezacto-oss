// Loads .dev.vars (if present) into process.env, then resolves the Harvest
// credentials this CLI needs.
//
// ezacto-migrate ships as a standalone published CLI (migration-spec §1), so
// .dev.vars is resolved from the user's working directory upwards — never
// relative to the installed module, which for a global install would point at
// <prefix>/lib/.dev.vars, a file no user will ever create.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface HarvestEnv {
  pat: string
  accountId: string | undefined
  userAgentEmail: string
}

const DEV_VARS_FILE = '.dev.vars'

/** Nearest `.dev.vars` at or above `from` (default: the process working dir). */
export const findDevVars = (from: string = process.cwd()): string | null => {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, DEV_VARS_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Loads the nearest `.dev.vars` into process.env and returns the file it used,
 * or null when there is none (CI, or vars already exported in the shell).
 * Shell-exported values win: process.loadEnvFile does not overwrite them.
 */
export const loadDevVars = (from?: string): string | null => {
  const path = findDevVars(from)
  if (!path) return null
  try {
    process.loadEnvFile(path)
    return path
  } catch {
    // Unreadable or malformed .dev.vars — fall back to the ambient environment,
    // and let readHarvestEnv name the missing variable.
    return null
  }
}

export const readHarvestEnv = (devVarsPath?: string | null): HarvestEnv => {
  const pat = process.env.HARVEST_PAT
  if (!pat) {
    const fix = devVarsPath
      ? `add HARVEST_PAT=<token> to ${devVarsPath}`
      : `export HARVEST_PAT=<token>, or create ${join(process.cwd(), DEV_VARS_FILE)} containing HARVEST_PAT=<token>`
    throw new Error(`HARVEST_PAT is not set — ${fix} (get a token from Harvest ID > Developers)`)
  }
  return {
    pat,
    accountId: process.env.HARVEST_ACCOUNT_ID || undefined,
    userAgentEmail: process.env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
  }
}
