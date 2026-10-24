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

    it('cancel that lands mid-run stops before the next chunk and is not overwritten', async () => {
      const h = await setup()
      let calls = 0
      const cancelling: AuthorityPort = {
        ...allow,
        check: async () => {
          calls += 1
          if (calls === 2) await h.store.cancel(h.runId, T0)
          return 'ok'
        },
      }
      const status = await driveApply(deps(h, cancelling), h.runId, 'w1')
      expect(status).toMatchObject({
        state: 'cancelled',
        code: 'cancelled-by-administrator',
        applied: 2,
      })
      expect(h.entryCount()).toBe(2)
    })

    it('cancel after the last chunk is not overwritten by complete', async () => {
      const h = await setup()
      let calls = 0
      const cancelling: AuthorityPort = {
        ...allow,
        check: async () => {
          calls += 1
          if (calls === 4) await h.store.cancel(h.runId, T0)
          return 'ok'
        },
      }
      const status = await driveApply(deps(h, cancelling), h.runId, 'w1')
      expect(status).toMatchObject({ state: 'cancelled', code: 'cancelled-by-administrator' })
    })

    it('cancelled is sticky against any later fenced state write', async () => {
      const h = await setup()
      const lease = (await h.store.acquireLease(h.runId, 'w1', T0))!
      await h.store.cancel(h.runId, T0)
      for (const state of ['running', 'paused', 'partial', 'complete', 'failed'] as const) {
        await h.store.setState(lease, state, null, T0)
        expect(await h.store.status(h.runId)).toMatchObject({
          state: 'cancelled',
          code: 'cancelled-by-administrator',
        })
      }
    })

    it('the plan is immutable and creating again with a different plan returns the original', async () => {
      const h = await setup()
      const altered = { ...plan, mappingSha256: 'c'.repeat(64), actorId: 'admin-2', totalRows: 9 }
      const again = await h.store.createRun(altered, [], later(5))
      expect(again).toMatchObject({ runId: h.runId, totalRows: plan.totalRows })
      expect(await h.store.plan(h.runId)).toEqual(plan)
      expect((await h.store.nextChunk(h.runId))?.index).toBe(0)
    })

    it('a failed commit leaves no entry, and a replayed key under another run adds no entry', async () => {
      const h = await setup()
      const lease = (await h.store.acquireLease(h.runId, 'w1', T0))!
      h.failNext(1)
      await expect(h.store.commitChunk(lease, chunks[0]!, T0)).rejects.toMatchObject({
        errorClass: 'storage',
      })
      expect(h.entryCount()).toBe(0)
      expect((await h.store.nextChunk(h.runId))?.index).toBe(0)
      await h.store.commitChunk(lease, chunks[0]!, T0)
      expect(h.entryCount()).toBe(2)
      // Same source, different file: the recorded source keys must dedupe it.
      const other = { ...plan, fileSha256: 'd'.repeat(64) }
      await h.store.createRun(other, chunks, T0)
      const otherId = [other.destinationId, other.sourceId, other.fileSha256].join(':')
      const done = await driveApply({ ...deps(h), now: () => later(120_000) }, otherId, 'w2')
      expect(done).toMatchObject({ state: 'complete', applied: 3, alreadyImported: 2 })
      expect(h.entryCount()).toBe(5)
    })

    it('a partial run and a paused run both resume to completion', async () => {
      const partial = await setup()
      partial.failNext(99)
      expect((await driveApply(deps(partial), partial.runId, 'w1')).state).toBe('partial')
      partial.failNext(0)
      const resumed = await driveApply(
        { ...deps(partial), now: () => later(120_000) },
        partial.runId,
        'w2',
      )
      expect(resumed).toMatchObject({ state: 'complete', code: null, applied: 5 })
      expect(partial.entryCount()).toBe(5)

      const paused = await setup()
      const revoked = { ...allow, check: async () => 'revoked' as const }
      expect((await driveApply(deps(paused, revoked), paused.runId, 'w1')).state).toBe('paused')
      const back = await driveApply(
        { ...deps(paused), now: () => later(120_000) },
        paused.runId,
        'w2',
      )
      expect(back).toMatchObject({ state: 'complete', code: null, applied: 5 })
    })

    it('a holder fenced out mid-run returns quietly and the new holder finishes', async () => {
      const h = await setup()
      let calls = 0
      const stolen: AuthorityPort = {
        ...allow,
        check: async () => {
          calls += 1
          if (calls === 2) await h.store.acquireLease(h.runId, 'w2', later(120_000))
          return 'ok'
        },
      }
      const status = await driveApply(deps(h, stolen), h.runId, 'w1')
      expect(status).toMatchObject({ state: 'running', applied: 2 })
      const done = await driveApply({ ...deps(h), now: () => later(300_000) }, h.runId, 'w3')
      expect(done).toMatchObject({ state: 'complete', applied: 5 })
      expect(h.entryCount()).toBe(5)
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
