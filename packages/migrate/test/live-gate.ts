// The opt-in the three live suites hang on.
//
// These suites sweep the real CONFLICT Harvest account, so what turns them on
// has to be a statement of intent. It used to be "HARVEST_PAT is set", which is
// not that statement: the documented setup — copy .dev.vars.example, fill it in
// — makes credentials present for ordinary CLI work, and env.loadDevVars walks
// *upwards*, so a .dev.vars anywhere above the checkout armed them too. A plain
// `npm test` then spent its evening in Harvest's 429 backoff against production.
//
// The old design's objection stands and is answered below: a [manual] acceptance
// box that silently never runs is worse than one that fails. Asking for the live
// suites without credentials is now a loud failure (readLiveHarvestEnv throws),
// not a skip — only *not asking* skips, and the skip says so.

import type { HarvestEnv } from '../src/env.js'

/**
 * The opt-in variable. It is deliberately not one of env.ts's HARVEST_KEYS, so
 * it cannot arrive from a .dev.vars found by the upward walk — it has to be put
 * in the environment by whoever is running the acceptance sweep.
 */
export const LIVE_OPT_IN = 'EZACTO_LIVE_HARVEST'

export interface LiveGate {
  /** True when the operator asked for the live sweep. */
  enabled: boolean
  /** Why the suite is not running; empty when it is. */
  reason: string
}

export const liveHarvestGate = (env: NodeJS.ProcessEnv = process.env): LiveGate =>
  env[LIVE_OPT_IN] === '1'
    ? { enabled: true, reason: '' }
    : { enabled: false, reason: `${LIVE_OPT_IN}=1 not set (it sweeps the live Harvest account)` }

/**
 * The credentials for an opted-in run. Throws rather than skips: the operator
 * has said they want the live sweep, so a missing PAT is a broken request, not
 * an absent one.
 */
export const readLiveHarvestEnv = (
  env: NodeJS.ProcessEnv = process.env,
): HarvestEnv & { accountId: string } => {
  const pat = env.HARVEST_PAT
  const accountId = env.HARVEST_ACCOUNT_ID
  if (!pat || !accountId) {
    const missing = [!pat && 'HARVEST_PAT', !accountId && 'HARVEST_ACCOUNT_ID'].filter(Boolean)
    throw new Error(
      `${LIVE_OPT_IN}=1 asks for the live Harvest sweep, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set — export the credentials, or put them in .dev.vars`,
    )
  }
  return {
    pat,
    accountId,
    userAgentEmail: env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
  }
}

/**
 * Prints why a live suite is not running. Vitest's default reporter counts
 * skipped tests without naming them, and an unexplained skip is how the old gate
 * stayed invisible for as long as it did.
 *
 * Written straight to stdout: this runs while the file is being collected, and a
 * `console.log` there belongs to no task yet, so vitest's console interception
 * drops it on the floor.
 */
export const announceSkip = (
  suite: string,
  gate: LiveGate,
  write: (line: string) => void = (line) => void process.stdout.write(line),
): void => {
  if (!gate.enabled) write(`skipping ${suite} — ${gate.reason}\n`)
}
