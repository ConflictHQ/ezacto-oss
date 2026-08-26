// Loads the three Harvest variables this CLI reads out of .dev.vars (if present),
// then resolves them.
//
// ezacto-migrate ships as a standalone published CLI (migration-spec §1), so
// .dev.vars is resolved from the user's working directory upwards — never
// relative to the installed module, which for a global install would point at
// <prefix>/lib/.dev.vars, a file no user will ever create.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'

export interface HarvestEnv {
  pat: string
  accountId: string | undefined
  userAgentEmail: string
}

const DEV_VARS_FILE = '.dev.vars'

/**
 * The only keys a .dev.vars is allowed to set for this process.
 *
 * The upward walk below ends at `/`, so the file it finds is not necessarily one
 * the user wrote — a cloned repo, an unpacked tarball, a shared working tree or a
 * planted ~/.dev.vars all sit on the path of an ordinary `ezacto-migrate extract`.
 * Handing such a file to `process.loadEnvFile` set *every* key in it, and Node
 * reads some of its own lazily: one line of `NODE_TLS_REJECT_UNAUTHORIZED=0` in a
 * directory above the user turns off certificate verification for every request
 * this CLI then makes, each of which carries the account's PAT by construction.
 * The origin allow-list (harvest-client `isApiOrigin`, the manual-redirect
 * refusal, the paginator's off-origin check) is all still enforced — and all of it
 * defeated a layer below itself, because the impostor answers on the pinned URL.
 *
 * So the file is parsed and read from, never applied wholesale. `util.parseEnv` is
 * the parser `process.loadEnvFile` runs on the same bytes, so what counts as a
 * .dev.vars — quoting, comments, `export` prefixes — is unchanged.
 */
const HARVEST_KEYS = ['HARVEST_PAT', 'HARVEST_ACCOUNT_ID', 'HARVEST_USER_AGENT_EMAIL'] as const

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
 * Copies the HARVEST_* variables out of the nearest `.dev.vars` into process.env
 * and returns the file it used, or null when there is none (CI, or vars already
 * exported in the shell). Every other key in the file is read and dropped.
 *
 * Shell-exported values win, as `process.loadEnvFile` had it: a key already
 * present in the environment — empty string included — is left alone.
 */
export const loadDevVars = (from?: string): string | null => {
  const path = findDevVars(from)
  if (!path) return null
  try {
    const parsed = parseEnv(readFileSync(path, 'utf8'))
    for (const key of HARVEST_KEYS) {
      const value = parsed[key]
      if (value !== undefined && process.env[key] === undefined) process.env[key] = value
    }
    return path
  } catch {
    // Unreadable .dev.vars — fall back to the ambient environment, and let
    // readHarvestEnv name the missing variable.
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
