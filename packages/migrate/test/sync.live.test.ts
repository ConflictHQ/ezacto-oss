// The parallel-run proof cannot be faked: an actual Harvest account must accept
// two consecutive syncs without producing a deletion or domain delta. CI has no
// credentials, so this stays a credential-gated acceptance test like extract.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAuth } from '../src/auth.js'
import { loadDevVars } from '../src/env.js'
import { runSync } from '../src/sync.js'

loadDevVars()
const hasLiveCreds = Boolean(process.env.HARVEST_PAT && process.env.HARVEST_ACCOUNT_ID)

describe.skipIf(!hasLiveCreds)('runSync [e2e:migrate-reconcile] against the live CONFLICT account', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-sync-live-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('makes a second sync a no-op for domain rows and deletion marks', async () => {
    const env = {
      pat: process.env.HARVEST_PAT as string,
      accountId: process.env.HARVEST_ACCOUNT_ID,
      userAgentEmail: process.env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
    }
    await runAuth({ env, toolVersion: '0.0.0', snapshotDir: dir })
    await runSync({ env, snapshotDir: dir })

    const second = await runSync({ env, snapshotDir: dir })
    // Full-ID witness timestamps and request counts legitimately change. The
    // parallel-run invariant is zero domain/deletion delta, not byte equality of
    // the whole manifest.
    expect(second.deleted).toBe(0)
    expect(second.restored).toBe(0)
  }, 900_000)
})
