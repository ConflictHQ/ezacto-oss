// The parallel-run proof cannot be faked. The frozen-server unit test proves a
// strict second-sync no-op; this live test additionally proves that any row delta
// on the actively used account carries evidence of a newer upstream version.
// CI has no credentials, so it stays credential-gated like extract.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAuth } from '../src/auth.js'
import { loadDevVars } from '../src/env.js'
import { readManifest } from '../src/manifest.js'
import { RESOURCES } from '../src/resources.js'
import { runSync } from '../src/sync.js'

loadDevVars()
const hasLiveCreds = Boolean(process.env.HARVEST_PAT && process.env.HARVEST_ACCOUNT_ID)
// The live account currently has hundreds of invoices. Each sync deliberately
// visits every invoice message/payment endpoint twice (extract + ID witness),
// and this acceptance test runs two syncs under Harvest's 100 req / 15 s budget.
const LIVE_SYNC_TIMEOUT_MS = 30 * 60_000

const normalizedRaw = async (snapshotDir: string): Promise<Record<string, string[]>> => {
  const rawDir = join(snapshotDir, 'raw')
  const names = (await readdir(rawDir)).filter((name) => name.endsWith('.jsonl')).sort()
  const entries = await Promise.all(
    names.map(async (name) => {
      const rows = (await readFile(join(rawDir, name), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: number })
        .sort((a, b) => a.id - b.id)
        .map((row) => JSON.stringify(row))
      return [name, rows] as const
    }),
  )
  return Object.fromEntries(entries)
}

interface RawRowDifference {
  added: { id: number; created_at: string | null; updated_at: string | null }[]
  removed: number[]
  changed: {
    id: number
    fields: string[]
    before_updated_at: string | null
    after_updated_at: string | null
  }[]
}

const timestamp = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null

/** Compact diagnostics: Vitest cannot render a useful diff for ~34k raw rows. */
const rawDifferences = (
  before: Record<string, string[]>,
  after: Record<string, string[]>,
): Record<string, RawRowDifference> => {
  const differences: Record<string, RawRowDifference> = {}
  for (const resource of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const beforeRows = new Map(
      (before[resource] ?? []).map((line) => {
        const row = JSON.parse(line) as Record<string, unknown> & { id: number }
        return [row.id, row] as const
      }),
    )
    const afterRows = new Map(
      (after[resource] ?? []).map((line) => {
        const row = JSON.parse(line) as Record<string, unknown> & { id: number }
        return [row.id, row] as const
      }),
    )
    const added = [...afterRows.entries()]
      .filter(([id]) => !beforeRows.has(id))
      .map(([id, row]) => ({
        id,
        created_at: timestamp(row.created_at),
        updated_at: timestamp(row.updated_at),
      }))
      .sort((a, b) => a.id - b.id)
    const removed = [...beforeRows.keys()].filter((id) => !afterRows.has(id)).sort((a, b) => a - b)
    const changed = [...afterRows.entries()]
      .filter(([id, row]) => beforeRows.has(id) && !isDeepStrictEqual(beforeRows.get(id), row))
      .map(([id, row]) => {
        const beforeRow: Record<string, unknown> = beforeRows.get(id) ?? {}
        return {
          id,
          fields: [...new Set([...Object.keys(beforeRow), ...Object.keys(row)])]
            .filter((field) => !isDeepStrictEqual(beforeRow[field], row[field]))
            .sort(),
          before_updated_at: timestamp(beforeRow.updated_at),
          after_updated_at: timestamp(row.updated_at),
        }
      })
      .sort((a, b) => a.id - b.id)
    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      differences[resource] = { added, removed, changed }
    }
  }
  return differences
}

/** Reject drift unless the row itself proves Harvest created or advanced it. */
const unexplainedRawDifferences = (
  differences: Record<string, RawRowDifference>,
  liveWindowStartedAt: string,
): Record<string, RawRowDifference> => {
  const unexplained: Record<string, RawRowDifference> = {}
  for (const [resource, difference] of Object.entries(differences)) {
    const added = difference.added.filter(
      (row) =>
        (row.created_at === null || row.created_at < liveWindowStartedAt) &&
        (row.updated_at === null || row.updated_at < liveWindowStartedAt),
    )
    const changed = difference.changed.filter(
      (row) =>
        row.before_updated_at === null ||
        row.after_updated_at === null ||
        row.after_updated_at <= row.before_updated_at,
    )
    if (added.length > 0 || difference.removed.length > 0 || changed.length > 0) {
      unexplained[resource] = { added, removed: difference.removed, changed }
    }
  }
  return unexplained
}

describe('live raw difference classification', () => {
  it('[unit] accepts a row only when its upstream version advances', () => {
    const before = {
      'time_entries.jsonl': [
        JSON.stringify({ id: 1, notes: 'before', updated_at: '2026-08-27T18:00:00Z' }),
      ],
    }
    const after = {
      'time_entries.jsonl': [
        JSON.stringify({ id: 1, notes: 'after', updated_at: '2026-08-27T19:00:00Z' }),
      ],
    }

    expect(
      unexplainedRawDifferences(rawDifferences(before, after), '2026-08-27T17:00:00Z'),
    ).toEqual({})
  })

  it('[unit] reports same-version changes, unexplained additions, and removals', () => {
    const before = {
      'time_entries.jsonl': [
        JSON.stringify({ id: 1, notes: 'before', updated_at: '2026-08-27T18:00:00Z' }),
        JSON.stringify({ id: 2, notes: 'removed', updated_at: '2026-08-27T18:00:00Z' }),
      ],
    }
    const after = {
      'time_entries.jsonl': [
        JSON.stringify({ id: 1, notes: 'after', updated_at: '2026-08-27T18:00:00Z' }),
        JSON.stringify({
          id: 3,
          notes: 'old addition',
          created_at: '2026-08-26T18:00:00Z',
          updated_at: '2026-08-26T18:00:00Z',
        }),
      ],
    }

    expect(
      unexplainedRawDifferences(rawDifferences(before, after), '2026-08-27T17:00:00Z'),
    ).toEqual({
      'time_entries.jsonl': {
        added: [
          {
            id: 3,
            created_at: '2026-08-26T18:00:00Z',
            updated_at: '2026-08-26T18:00:00Z',
          },
        ],
        removed: [2],
        changed: [
          {
            id: 1,
            fields: ['notes'],
            before_updated_at: '2026-08-27T18:00:00Z',
            after_updated_at: '2026-08-27T18:00:00Z',
          },
        ],
      },
    })
  })
})

describe.skipIf(!hasLiveCreds)('runSync [e2e:migrate-reconcile] against the live CONFLICT account', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-sync-live-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('makes a second sync stable except for newer upstream row versions', async () => {
    const env = {
      pat: process.env.HARVEST_PAT as string,
      accountId: process.env.HARVEST_ACCOUNT_ID,
      userAgentEmail: process.env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
    }
    await runAuth({ env, toolVersion: '0.0.0', snapshotDir: dir })
    const liveWindowStartedAt = new Date().toISOString()
    const first = await runSync({ env, snapshotDir: dir })
    const afterFirst = await normalizedRaw(dir)

    const second = await runSync({ env, snapshotDir: dir })
    const afterSecond = await normalizedRaw(dir)
    // Full-ID witness timestamps and request counts legitimately change. The
    // parallel-run invariant is zero domain/deletion delta, not byte equality of
    // the whole manifest.
    expect(second.deleted).toBe(0)
    expect(second.restored).toBe(0)
    expect(
      unexplainedRawDifferences(
        rawDifferences(afterFirst, afterSecond),
        liveWindowStartedAt,
      ),
    ).toEqual({})
    expect(first.complete).toBe(true)
    expect(second.complete).toBe(true)
    expect(second.unwitnessed).toEqual({})

    const manifest = await readManifest(dir)
    for (const step of RESOURCES) {
      if (step.name === 'teammates' || (step.requires && !manifest.preflight[step.requires])) continue
      expect(manifest.full_id_sweeps?.[step.name], `${step.name} must be deletion-witnessed`).toBeDefined()
    }
  }, LIVE_SYNC_TIMEOUT_MS)
})
