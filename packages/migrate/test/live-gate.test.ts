// [unit] The gate itself, tested with an injected environment — the thing it
// guards costs 20+ minutes of Harvest 429 backoff, so it is not exercised by
// running the suites it gates.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIVE_OPT_IN, announceSkip, liveHarvestGate, readLiveHarvestEnv } from './live-gate.js'

const CREDS = { HARVEST_PAT: 'pat', HARVEST_ACCOUNT_ID: '12345' }

describe('live Harvest gate', () => {
  it('stays closed when only credentials are present', () => {
    // The regression: a filled-in .dev.vars is the documented setup, and it used
    // to be enough to point a plain `npm test` at the production account.
    expect(liveHarvestGate({ ...CREDS })).toEqual({
      enabled: false,
      reason: 'EZACTO_LIVE_HARVEST=1 not set (it sweeps the live Harvest account)',
    })
  })

  it('opens only on the explicit opt-in', () => {
    expect(liveHarvestGate({ [LIVE_OPT_IN]: '1' }).enabled).toBe(true)
    for (const value of ['', '0', 'true', 'yes']) {
      expect(liveHarvestGate({ [LIVE_OPT_IN]: value }).enabled, `${LIVE_OPT_IN}=${value}`).toBe(
        false,
      )
    }
  })

  it('names the reason it is closed, and says nothing when it is open', () => {
    const lines: string[] = []
    announceSkip('a live suite', liveHarvestGate({}), (line) => lines.push(line))
    announceSkip('a live suite', liveHarvestGate({ [LIVE_OPT_IN]: '1' }), (line) =>
      lines.push(line),
    )
    expect(lines).toEqual([
      `skipping a live suite — ${LIVE_OPT_IN}=1 not set (it sweeps the live Harvest account)\n`,
    ])
  })

  it('fails loudly when the opt-in arrives without credentials', () => {
    // The objection the old gate was answering: a [manual] acceptance box that
    // silently never runs is worse than one that fails. Asking still fails.
    expect(() => readLiveHarvestEnv({ [LIVE_OPT_IN]: '1' })).toThrow(
      `${LIVE_OPT_IN}=1 asks for the live Harvest sweep, but HARVEST_PAT and HARVEST_ACCOUNT_ID are not set — export the credentials, or put them in .dev.vars`,
    )
    expect(() => readLiveHarvestEnv({ [LIVE_OPT_IN]: '1', ...CREDS, HARVEST_PAT: '' })).toThrow(
      /HARVEST_PAT is not set/,
    )
    expect(() =>
      readLiveHarvestEnv({ [LIVE_OPT_IN]: '1', ...CREDS, HARVEST_ACCOUNT_ID: '' }),
    ).toThrow(/HARVEST_ACCOUNT_ID is not set/)
  })

  it('resolves the credentials an opted-in run uses', () => {
    expect(readLiveHarvestEnv({ ...CREDS })).toEqual({
      pat: 'pat',
      accountId: '12345',
      userAgentEmail: 'hello@ezacto.com',
    })
    expect(readLiveHarvestEnv({ ...CREDS, HARVEST_USER_AGENT_EMAIL: 'a@b.c' }).userAgentEmail).toBe(
      'a@b.c',
    )
  })
})

describe('live suites are gated on the opt-in', () => {
  // Static, because the alternative is running them. Each live file has to hang
  // off gate.enabled and nothing else: the bug was one guard expression copied
  // three times, and it will be copied a fourth.
  const here = dirname(fileURLToPath(import.meta.url))

  for (const name of ['auth.live.test.ts', 'extract.live.test.ts', 'sync.live.test.ts']) {
    it(`${name} skips unless ${LIVE_OPT_IN} is set`, () => {
      const source = readFileSync(join(here, name), 'utf8')
      expect(source).toContain("from './live-gate.js'")
      expect(source).toContain('describe.skipIf(!gate.enabled)(SUITE')
      expect(source).not.toMatch(/skipIf\(!hasLiveCreds\)/)
    })
  }
})
