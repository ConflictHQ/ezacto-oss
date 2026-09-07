import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAuth } from '../src/auth.js'
import { loadDevVars } from '../src/env.js'
import { announceSkip, liveHarvestGate, readLiveHarvestEnv } from './live-gate.js'

const SUITE = 'runAuth [manual/api] against the live CONFLICT account'
const gate = liveHarvestGate()
announceSkip(SUITE, gate)
// The CLI loads .dev.vars itself; a test process does not. Only an opted-in run
// needs the credentials, so only an opted-in run goes looking for them.
if (gate.enabled) loadDevVars()

describe.skipIf(!gate.enabled)(SUITE, () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-auth-live-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves the configured account and confirms administrator access', async () => {
    const env = readLiveHarvestEnv()
    const result = await runAuth({ env, toolVersion: '0.0.0', snapshotDir: dir })

    expect(result.account.id).toBe(env.accountId)
    expect(result.isAdministrator).toBe(true)
  })
})
