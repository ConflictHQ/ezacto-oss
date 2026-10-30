import { describe, expect, it } from 'vitest'
import {
  csvPlanId,
  type AdministratorActor,
  type CsvDatasetLedger,
  type CsvPlanInput,
} from '../src/csv-dataset-contract.js'

export const admin: AdministratorActor = { kind: 'administrator', userId: 'admin-1' }

export const basePlan: CsvPlanInput = {
  datasetId: 'clockify-ws-1',
  fileSha256: 'f'.repeat(64),
  mappingSha256: 'a'.repeat(64),
  adapterId: 'clockify',
  identityVersion: 1,
  dateFormat: 'iso',
  exporterZone: 'America/Costa_Rica',
  excludedLines: [],
  destinationVersion: 'dest-1',
}

/**
 * What every real ledger (SQLite, later D1) must pass. `fingerprint` reads
 * the complete destination state so non-mutation can be asserted.
 */
export const csvDatasetLedgerContract = (
  name: string,
  create: () => {
    ledger: CsvDatasetLedger
    fingerprint: () => Promise<string> | string
    timeCount: () => Promise<number> | number
  },
) =>
  describe(`${name}: sealed dataset ledger contract`, () => {
    it('[unit] a draft seal writes no time and leaves nothing to resume', async () => {
      const { ledger, timeCount } = create()
      const result = await ledger.seal(admin, basePlan, false)
      expect(result).toMatchObject({ outcome: 'created', run: { status: 'draft', actor: null } })
      expect(await timeCount()).toBe(0)
    })

    it('[unit] replacing a draft discards only the preview; the dataset id is unchanged', async () => {
      const { ledger } = create()
      await ledger.seal(admin, basePlan, false)
      const replaced = await ledger.seal(admin, { ...basePlan, fileSha256: 'b'.repeat(64) }, false)
      expect(replaced.outcome).toBe('created')
      expect(replaced.outcome === 'created' && replaced.run.plan.datasetId).toBe(basePlan.datasetId)
    })

    it('[unit] confirmation requires an administrator actor and records who', async () => {
      const { ledger } = create()
      const refused = await ledger.seal({ kind: 'administrator', userId: '' }, basePlan, true)
      expect(refused).toMatchObject({ outcome: 'blocked', reason: 'actor_required' })
      const ok = await ledger.seal(admin, basePlan, true)
      expect(ok).toMatchObject({ outcome: 'created', run: { status: 'partial', actor: admin } })
    })

    it('[unit] the same immutable plan reopens its run, even with exclusions reordered', async () => {
      const { ledger } = create()
      const plan = { ...basePlan, excludedLines: [7, 3] }
      const first = await ledger.seal(admin, plan, true)
      const again = await ledger.seal(admin, { ...plan, excludedLines: [3, 7, 3] }, true)
      expect(again.outcome).toBe('reopened')
      expect(again.outcome === 'reopened' && first.outcome === 'created' && again.run.runId).toBe(
        first.outcome === 'created' ? first.run.runId : '',
      )
    })

    it.each([
      ['different_file', { fileSha256: 'c'.repeat(64) }],
      ['different_mapping', { mappingSha256: 'd'.repeat(64) }],
      ['different_adapter', { identityVersion: 2 }],
      ['different_adapter', { adapterId: 'toggl' }],
      ['different_selection', { excludedLines: [4] }],
      ['different_selection', { exporterZone: 'UTC' }],
      ['different_destination', { destinationVersion: 'dest-2' }],
    ] as const)('[unit] a confirmed dataset blocks a change (%s)', async (reason, change) => {
      const { ledger, timeCount } = create()
      await ledger.seal(admin, basePlan, true)
      const result = await ledger.seal(admin, { ...basePlan, ...change }, true)
      expect(result).toMatchObject({ outcome: 'blocked', reason })
      expect(await timeCount()).toBe(0)
    })

    it('[unit] writes reject a stale plan, an excluded line, a draft and a missing actor', async () => {
      const { ledger } = create()
      const draft = await ledger.seal(admin, basePlan, false)
      if (draft.outcome !== 'created') throw new Error('setup')
      await expect(
        ledger.commitEntry(admin, draft.run.runId, draft.run.planId, 'k', { line: 2, seconds: 60 }),
      ).rejects.toThrow('not_confirmed')
      const sealed = await ledger.seal(admin, { ...basePlan, excludedLines: [5] }, true)
      if (sealed.outcome !== 'created') throw new Error('setup')
      const { runId, planId } = sealed.run
      await expect(
        ledger.commitEntry(admin, runId, csvPlanId(basePlan), 'k', { line: 2, seconds: 60 }),
      ).rejects.toThrow('stale_plan')
      await expect(
        ledger.commitEntry(admin, runId, planId, 'k', { line: 5, seconds: 60 }),
      ).rejects.toThrow('excluded_line')
      await expect(
        ledger.commitEntry({ kind: 'administrator', userId: '' }, runId, planId, 'k', {
          line: 2,
          seconds: 60,
        }),
      ).rejects.toThrow('actor_required')
    })

    it('[integration] double delivery and concurrent replay create one time entry', async () => {
      const { ledger, timeCount } = create()
      const sealed = await ledger.seal(admin, basePlan, true)
      if (sealed.outcome !== 'created') throw new Error('setup')
      const { runId, planId } = sealed.run
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          ledger.commitEntry(admin, runId, planId, 'row-hash#1', { line: 2, seconds: 3600 }),
        ),
      )
      expect(results.filter((r) => r.outcome === 'written')).toHaveLength(1)
      expect(await timeCount()).toBe(1)
      const run = await ledger.getRun(runId)
      expect(run).toMatchObject({ written: 1, alreadyImported: 4, actor: admin })
    })

    it('[integration] identical rows stay separate through their occurrence suffix', async () => {
      const { ledger, timeCount } = create()
      const sealed = await ledger.seal(admin, basePlan, true)
      if (sealed.outcome !== 'created') throw new Error('setup')
      const { runId, planId } = sealed.run
      await ledger.commitEntry(admin, runId, planId, 'h#1', { line: 2, seconds: 60 })
      await ledger.commitEntry(admin, runId, planId, 'h#2', { line: 3, seconds: 60 })
      expect(await timeCount()).toBe(2)
    })

    it('[integration] a source-id change cannot bypass dedup: the dataset id is the identity', async () => {
      const { ledger, timeCount } = create()
      const sealed = await ledger.seal(admin, basePlan, true)
      if (sealed.outcome !== 'created') throw new Error('setup')
      await ledger.commitEntry(admin, sealed.run.runId, sealed.run.planId, 'h#1', {
        line: 2,
        seconds: 60,
      })
      // A new file for the same dataset is blocked rather than appended under a fresh run.
      const other = await ledger.seal(admin, { ...basePlan, fileSha256: 'e'.repeat(64) }, true)
      expect(other.outcome).toBe('blocked')
      expect(await timeCount()).toBe(1)
    })

    it('[unit] sealing a draft (preview) changes no earlier-confirmed state', async () => {
      const { ledger, fingerprint } = create()
      const sealed = await ledger.seal(admin, basePlan, true)
      if (sealed.outcome !== 'created') throw new Error('setup')
      await ledger.commitEntry(admin, sealed.run.runId, sealed.run.planId, 'h#1', {
        line: 2,
        seconds: 60,
      })
      const before = await fingerprint()
      await ledger.seal(admin, { ...basePlan, fileSha256: '0'.repeat(64) }, false)
      expect(await fingerprint()).toBe(before)
    })
  })
