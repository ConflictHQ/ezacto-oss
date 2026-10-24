import {
  ApplyError,
  LEASE_TTL_MS,
  RETENTION_MS,
  type ApplyChunk,
  type ApplyCode,
  type ApplyState,
  type ApplyStatus,
  type ApplyStore,
  type ChunkResult,
  type Lease,
  type SealedPlan,
} from '../src/csv-apply-contract.js'

interface Run {
  id: string
  plan: SealedPlan
  chunks: ApplyChunk[]
  done: Set<number>
  state: ApplyState
  code: ApplyCode | null
  applied: number
  alreadyImported: number
  destinationSeconds: number
  createdAt: string
}

/**
 * In-memory reference implementation of `ApplyStore`. It holds no real storage;
 * its job is to be the executable form of the contract that a SQLite (and later
 * D1) store must also pass. `failNext` injects a storage failure to exercise retry.
 */
export const createFakeApplyStore = (): ApplyStore & {
  failNext: (count: number) => void
  keys: Set<string>
} => {
  const runs = new Map<string, Run>()
  const leases = new Map<string, Lease>()
  const fences = new Map<string, number>()
  const keys = new Set<string>()
  let failures = 0
  const bySource = (plan: SealedPlan) => `${plan.destinationId}\u0000${plan.sourceId}`
  const view = (run: Run): ApplyStatus => ({
    runId: run.id,
    state: run.state,
    code: run.code,
    totalRows: run.plan.totalRows,
    excludedRows: run.plan.excludedRows,
    applied: run.applied,
    alreadyImported: run.alreadyImported,
    sourceSeconds: run.plan.sourceSeconds,
    destinationSeconds: run.destinationSeconds,
    retentionDeadline: new Date(Date.parse(run.createdAt) + RETENTION_MS).toISOString(),
  })
  const get = (id: string): Run => {
    const run = runs.get(id)
    if (!run) throw new Error('unknown run')
    return run
  }
  const fenced = (lease: Lease): Run => {
    const run = get(lease.runId)
    if (leases.get(bySource(run.plan))?.fence !== lease.fence) throw new ApplyError('stale-lease')
    return run
  }
  return {
    keys,
    failNext: (count) => {
      failures = count
    },
    async createRun(plan, chunks, now) {
      const id = [plan.destinationId, plan.sourceId, plan.fileSha256].join(':')
      const run = runs.get(id) ?? {
        id,
        plan,
        chunks,
        done: new Set<number>(),
        state: 'ready' as ApplyState,
        code: null,
        applied: 0,
        alreadyImported: 0,
        destinationSeconds: 0,
        createdAt: now,
      }
      runs.set(id, run)
      return view(run)
    },
    async plan(runId) {
      return get(runId).plan
    },
    async acquireLease(runId, holder, now) {
      const run = get(runId)
      const live = leases.get(bySource(run.plan))
      if (live && Date.parse(live.expiresAt) > Date.parse(now)) return null
      const fence = (fences.get(bySource(run.plan)) ?? 0) + 1
      fences.set(bySource(run.plan), fence)
      const lease = {
        runId,
        holder,
        fence,
        expiresAt: new Date(Date.parse(now) + LEASE_TTL_MS).toISOString(),
      }
      leases.set(bySource(run.plan), lease)
      return { runId, holder, fence, expiresAt: lease.expiresAt }
    },
    async nextChunk(runId) {
      const run = get(runId)
      return run.chunks.find((chunk) => !run.done.has(chunk.index)) ?? null
    },
    async commitChunk(lease, chunk): Promise<ChunkResult> {
      const run = fenced(lease)
      if (failures > 0) {
        failures -= 1
        throw new ApplyError('storage')
      }
      const result: ChunkResult = { inserted: 0, alreadyImported: 0, destinationSeconds: 0 }
      if (run.done.has(chunk.index)) return result
      for (const row of chunk.rows) {
        const key = `${run.plan.sourceId}\u0000${row.sourceKey}`
        if (keys.has(key)) {
          result.alreadyImported += 1
        } else {
          keys.add(key)
          result.inserted += 1
          result.destinationSeconds += row.destinationSeconds
        }
      }
      run.done.add(chunk.index)
      run.applied += result.inserted
      run.alreadyImported += result.alreadyImported
      run.destinationSeconds += result.destinationSeconds
      return result
    },
    async setState(lease, state, code) {
      const run = fenced(lease)
      if (run.state === 'cancelled') return
      run.state = state
      run.code = code
    },
    async cancel(runId) {
      const run = get(runId)
      run.state = 'cancelled'
      run.code = 'cancelled-by-administrator'
    },
    async status(runId) {
      return view(get(runId))
    },
  }
}
