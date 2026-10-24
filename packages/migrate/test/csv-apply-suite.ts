import { describe, expect, it } from 'vitest'
import {
  ApplyError,
  driveApply,
  reconcile,
  type ApplyChunk,
  type ApplyStore,
  type AuthorityPort,
  type SealedPlan,
} from '../src/csv-apply-contract.js'

export interface ApplyHarness {
  store: ApplyStore
  /** Makes the next `count` chunk commits fail as a storage error. */
  failNext: (count: number) => void
  /** Count of time entries recorded for the source, read from the destination itself. */
  entryCount: () => number
}

const plan: SealedPlan = {
  destinationId: 'disposable-1',
  sourceId: 'clockify-main',
  fileSha256: 'a'.repeat(64),
  mappingSha256: 'b'.repeat(64),
  adapterVersion: 'clockify-1',
  actorId: 'admin-1',
  totalRows: 5,
  excludedRows: 0,
  sourceSeconds: 5 * 3600 + 3,
}
const rows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({
    sourceKey: `k${from + i}`,
    sourceSeconds: 3600 + (from + i === 0 ? 3 : 0),
    destinationSeconds: 3600 + (from + i === 0 ? 3 : 0),
  }))
export const chunks: ApplyChunk[] = [
  { index: 0, rows: rows(0, 2) },
  { index: 1, rows: rows(2, 4) },
  { index: 2, rows: rows(4, 5) },
]
const T0 = '2026-10-01T00:00:00.000Z'
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
const allow: AuthorityPort = {
  check: async () => 'ok',
  policyVersionMatches: async () => true,
}

/** What every real ApplyStore (SQLite now, D1 later) must pass. */
export const describeApplyContract = (name: string, make: () => ApplyHarness): void => {
  describe(`apply contract: ${name}`, () => {
    const setup = async () => {
      const h = make()
      await h.store.createRun(plan, chunks, T0)
      return { ...h, runId: [plan.destinationId, plan.sourceId, plan.fileSha256].join(':') }
    }
    const deps = (h: ApplyHarness, authority: AuthorityPort = allow) => ({
      store: h.store,
      authority,
      now: () => T0,
    })

    it('first apply matches, replay adds zero, and creating the run twice is one run', async () => {
      const h = await setup()
      const again = await h.store.createRun(plan, chunks, later(5))
      expect(again.runId).toBe(h.runId)
      const done = await driveApply(deps(h), h.runId, 'w1')
      expect(done).toMatchObject({ state: 'complete', applied: 5, alreadyImported: 0 })
      expect(h.entryCount()).toBe(5)
      expect(reconcile(plan, done)).toMatchObject({ countsMatch: true, roundingDeltaSeconds: 0 })
      await driveApply(deps(h), h.runId, 'w2')
      expect(h.entryCount()).toBe(5)
    })

    it('a chunk delivered twice adds nothing the second time', async () => {
      const h = await setup()
      const lease = (await h.store.acquireLease(h.runId, 'w1', T0))!
      const first = await h.store.commitChunk(lease, chunks[0]!, T0)
      const second = await h.store.commitChunk(lease, chunks[0]!, T0)
      expect(first.inserted).toBe(2)
      expect(second.inserted).toBe(0)
      expect(h.entryCount()).toBe(2)
    })

    it('a stale lease cannot write, and a live lease blocks a second holder', async () => {
      const h = await setup()
      const old = (await h.store.acquireLease(h.runId, 'w1', T0))!
      expect(await h.store.acquireLease(h.runId, 'w2', later(1000))).toBeNull()
      const next = (await h.store.acquireLease(h.runId, 'w2', later(120_000)))!
      expect(next.fence).toBeGreaterThan(old.fence)
      await expect(h.store.commitChunk(old, chunks[0]!, T0)).rejects.toMatchObject({
        errorClass: 'stale-lease',
      })
      await expect(h.store.setState(old, 'complete', null, T0)).rejects.toBeInstanceOf(ApplyError)
      expect(h.entryCount()).toBe(0)
    })

    it('interruption resumes with only the remainder', async () => {
      const h = await setup()
      const lease = (await h.store.acquireLease(h.runId, 'w1', T0))!
      await h.store.commitChunk(lease, chunks[0]!, T0)
      const blocked = await driveApply(deps(h), h.runId, 'w2')
      // The first lease is still live, so w2 does nothing until it expires.
      expect(blocked.applied).toBe(2)
      const resumed = await driveApply({ ...deps(h), now: () => later(120_000) }, h.runId, 'w3')
      expect(resumed).toMatchObject({ state: 'complete', applied: 5 })
      expect(h.entryCount()).toBe(5)
    })

    it('pauses on revoked or expired authority and on changed policy, writing nothing more', async () => {
      for (const [authority, code] of [
        [{ ...allow, check: async () => 'revoked' as const }, 'authority-revoked'],
        [{ ...allow, check: async () => 'expired' as const }, 'authority-expired'],
        [{ ...allow, policyVersionMatches: async () => false }, 'policy-changed'],
      ] as const) {
        const h = await setup()
        const status = await driveApply(deps(h, authority), h.runId, 'w1')
        expect(status).toMatchObject({ state: 'paused', code, applied: 0 })
        expect(h.entryCount()).toBe(0)
      }
    })

    it('retries storage failures a bounded number of times, then leaves resumable partial', async () => {
      const recovered = await setup()
      recovered.failNext(2)
      expect((await driveApply(deps(recovered), recovered.runId, 'w1')).state).toBe('complete')
      const stuck = await setup()
      stuck.failNext(99)
      const status = await driveApply(deps(stuck), stuck.runId, 'w1')
      expect(status).toMatchObject({ state: 'partial', code: 'storage-unavailable', applied: 0 })
    })

    it('cancel stops future chunks and keeps committed rows', async () => {
      const h = await setup()
      const lease = (await h.store.acquireLease(h.runId, 'w1', T0))!
      await h.store.commitChunk(lease, chunks[0]!, T0)
      await h.store.cancel(h.runId, T0)
      const status = await driveApply({ ...deps(h), now: () => later(120_000) }, h.runId, 'w2')
      expect(status).toMatchObject({
        state: 'cancelled',
        code: 'cancelled-by-administrator',
        applied: 2,
      })
      expect(h.entryCount()).toBe(2)
    })

    it('status carries the retention deadline and no free text', async () => {
      const h = await setup()
      const status = await h.store.status(h.runId)
      expect(status.retentionDeadline).toBe(later(24 * 60 * 60 * 1000))
      expect(Object.keys(status).sort()).toEqual(
        [
          'alreadyImported',
          'applied',
          'code',
          'destinationSeconds',
          'excludedRows',
          'retentionDeadline',
          'runId',
          'sourceSeconds',
          'state',
          'totalRows',
        ].sort(),
      )
    })
  })

  describe('reconcile', () => {
    it('reports exact counts, explicit rounding and no money field', () => {
      const status = {
        runId: 'r',
        state: 'complete' as const,
        code: null,
        totalRows: 3,
        excludedRows: 1,
        applied: 1,
        alreadyImported: 1,
        sourceSeconds: 7200,
        destinationSeconds: 7260,
        retentionDeadline: T0,
      }
      const result = reconcile({ ...plan, totalRows: 3, excludedRows: 1 }, status)
      expect(result).toEqual({
        countsMatch: true,
        roundingDeltaSeconds: 60,
        needsRoundingAcknowledgement: true,
        excluded: { rows: 1 },
      })
    })
  })
}
