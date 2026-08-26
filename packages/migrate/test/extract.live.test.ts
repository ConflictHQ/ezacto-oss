// AC #3: a full extract of the live account. Skipped, never mocked and never
// faked, when credentials are absent — CI holds no Harvest secrets, so this is a
// skip there rather than a red gate, and the counts it prints are the evidence
// the acceptance box is closed with.

import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAuth } from '../src/auth.js'
import { loadDevVars } from '../src/env.js'
import { runExtract } from '../src/extract.js'
import { readManifest } from '../src/manifest.js'
import { minElapsedMs } from '../src/rate-limiter.js'
import { RESOURCES } from '../src/resources.js'

loadDevVars()
const hasLiveCreds = Boolean(process.env.HARVEST_PAT && process.env.HARVEST_ACCOUNT_ID)

describe.skipIf(!hasLiveCreds)('runExtract [api] against the live CONFLICT account', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-extract-live-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('completes a full extract and records per-resource counts in manifest.json', async () => {
    const env = {
      pat: process.env.HARVEST_PAT as string,
      accountId: process.env.HARVEST_ACCOUNT_ID,
      userAgentEmail: process.env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
    }
    await runAuth({ env, toolVersion: '0.0.0', snapshotDir: dir })

    const result = await runExtract({ env, snapshotDir: dir })
    const manifest = await readManifest(dir)

    // Every step in the registry has an answer: swept, or explicitly skipped.
    for (const step of RESOURCES) {
      const record = manifest.resources[step.name]
      expect(record, `${step.name} has no manifest record`).toBeDefined()
      expect(
        record.complete || record.skipped_reason !== null,
        `${step.name} neither completed nor recorded why it was skipped`,
      ).toBe(true)
    }

    // The four resources any real Harvest account has.
    for (const name of ['users', 'clients', 'projects', 'time_entries']) {
      expect(manifest.resources[name].count, `${name} came back empty`).toBeGreaterThan(0)
    }

    // The manifest is not allowed to describe a snapshot that is not there.
    for (const [name, record] of Object.entries(manifest.resources)) {
      if (record.skipped_reason && record.count === 0 && record.pages === 0) continue
      const lines = (await readFile(join(dir, 'raw', `${name}.jsonl`), 'utf8'))
        .split('\n')
        .filter(Boolean)
      expect(lines, `${name}: manifest count vs raw/${name}.jsonl`).toHaveLength(record.count)
    }

    expect(manifest.finished_at).not.toBeNull()

    // The run was paced by the budget it declared (§2.2): past the first window,
    // every further RATE_LIMIT requests cost a full window, so a run of this many
    // requests cannot have finished sooner than this. Not an average rate — the
    // limiter spends its first window at once by design, so the average of a
    // correctly-paced run sits above the sustained figure and converges down to it.
    // See minElapsedMs; the per-grant window property is rate-limiter.test.ts's.
    const elapsedS = result.durationMs / 1000
    expect(result.durationMs).toBeGreaterThanOrEqual(minElapsedMs(result.requests))

    // Printed so it can be pasted into the PR as this AC's evidence.
    const width = Math.max(...Object.keys(manifest.resources).map((n) => n.length))
    for (const [name, record] of Object.entries(manifest.resources)) {
      console.log(
        `${name.padEnd(width)} ${String(record.count).padStart(7)} rows  ` +
          `${String(record.pages).padStart(4)} pages` +
          (record.skipped_reason ? `  skipped: ${record.skipped_reason}` : ''),
      )
    }
    console.log(
      `total: ${result.requests} requests in ${Math.round(elapsedS)}s ` +
        `(administrator: ${manifest.preflight.user.is_administrator})`,
    )
  }, 900_000)
})
