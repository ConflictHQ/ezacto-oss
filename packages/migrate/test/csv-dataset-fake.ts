import {
  csvPlanDifference,
  csvPlanId,
  type AdministratorActor,
  type CommitResult,
  type CsvDatasetLedger,
  type CsvDatasetRun,
  type CsvTimeEntry,
  type SealResult,
} from '../src/csv-dataset-contract.js'

/** In-memory ledger that satisfies the contract; also the destination the tests fingerprint. */
export const createFakeCsvDatasetLedger = () => {
  const runs = new Map<string, CsvDatasetRun>()
  const byDataset = new Map<string, string>()
  const keys = new Set<string>()
  const times: CsvTimeEntry[] = []
  let next = 0
  const isAdmin = (actor: AdministratorActor | undefined | null): actor is AdministratorActor =>
    actor?.kind === 'administrator' && actor.userId !== ''

  const ledger: CsvDatasetLedger = {
    async seal(actor, plan, confirm): Promise<SealResult> {
      if (confirm && !isAdmin(actor))
        return { outcome: 'blocked', reason: 'actor_required', run: null }
      const existingId = byDataset.get(plan.datasetId)
      const existing = existingId === undefined ? undefined : runs.get(existingId)
      const make = (): CsvDatasetRun => {
        next += 1
        const run: CsvDatasetRun = {
          runId: `run-${next}`,
          planId: csvPlanId(plan),
          plan,
          status: confirm ? 'partial' : 'draft',
          actor: confirm ? actor : null,
          written: 0,
          alreadyImported: 0,
        }
        runs.set(run.runId, run)
        byDataset.set(plan.datasetId, run.runId)
        return run
      }
      if (existing === undefined) return { outcome: 'created', run: make() }
      if (existing.status === 'draft') {
        runs.delete(existing.runId)
        return { outcome: 'created', run: make() }
      }
      const difference = csvPlanDifference(existing.plan, plan)
      if (difference !== null) return { outcome: 'blocked', reason: difference, run: existing }
      return { outcome: 'reopened', run: existing }
    },
    async getRun(runId) {
      return runs.get(runId) ?? null
    },
    async commitEntry(actor, runId, planId, sourceKey, entry): Promise<CommitResult> {
      const run = runs.get(runId)
      if (run === undefined) throw new Error('unknown_run')
      if (!isAdmin(actor)) throw new Error('actor_required')
      if (run.status === 'draft') throw new Error('not_confirmed')
      if (run.planId !== planId) throw new Error('stale_plan')
      if (run.plan.excludedLines.includes(entry.line)) throw new Error('excluded_line')
      // One synchronous step: the key and the time commit together or not at all.
      const key = `${run.plan.datasetId}\u0000${sourceKey}`
      if (keys.has(key)) {
        run.alreadyImported += 1
        return { outcome: 'duplicate' }
      }
      keys.add(key)
      times.push(entry)
      run.written += 1
      return { outcome: 'written' }
    },
    async finish(runId, status) {
      const run = runs.get(runId)
      if (run !== undefined) run.status = status
    },
  }
  return {
    ledger,
    /** Complete destination state; a preview must leave it unchanged. */
    fingerprint: (): string => JSON.stringify({ runs: [...runs], keys: [...keys], times }),
    timeCount: (): number => times.length,
  }
}
