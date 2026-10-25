import type BetterSqlite3 from 'better-sqlite3'
import {
  CsvApplyRefusal,
  CsvBrowserLedgerRefusal,
  csvPlanId,
  type CsvApplyCode,
  type CsvApplyContext,
  type CsvApplyLease,
  type CsvApplyState,
} from '@ezacto/core'
import { createCsvApplyRunStore } from '@ezacto/db'
import { createSqliteCsvBrowserService } from './csv-browser-sqlite.js'
import { csvBrowserSealInput } from './csv-planner.js'
import { CsvBrowserPlannerError } from './csv-browser-errors.js'
import type { CsvStagingApplyPort, CsvStagingApplyBinding } from './csv-staging-private.js'

/** Container-only bounded driver. The existing native run/chunks ARE its queue.
 * A tick never holds a transaction across an await. Each canonical setup/time
 * batch repeats current session, input incarnation, execution and lease guards. */
export const createSqliteCsvApplyDriver = (
  sqlite: BetterSqlite3.Database,
  staging: CsvStagingApplyPort,
  options: {
    holder: () => string
    signal?: AbortSignal
    reportError?: (cause: unknown) => void
    classifyError?: (cause: unknown) => CsvApplyCode | null
    now?: () => number
    maxRows?: number
    maxTickMs?: number
  },
) => {
  const runs = createCsvApplyRunStore(sqlite)
  const now = options.now ?? Date.now
  const report = (cause: unknown) => {
    try {
      const delivery: unknown = options.reportError?.(cause)
      void Promise.resolve(delivery).catch(() => undefined)
    } catch {
      /* Reporting cannot change custody. */
    }
  }
  const binding = (run: CsvApplyContext): CsvStagingApplyBinding => ({
    stageId: run.stageId,
    stageVersion: run.stageVersion,
    targetNonce: run.targetNonce,
    previewId: run.previewId,
    nativeRunId: Number(run.runId),
    leaseGeneration: run.leaseGeneration,
    commandId: run.confirmationCommandId,
  })
  const updateStage = async (run: CsvApplyContext) => {
    const updated = await staging.markSystemProgress(
      binding(run),
      run.state === 'complete' ? 'completed' : run.state,
      run.code ?? undefined,
      run.finishedAt ?? undefined,
    )
    return updated ? (runs.recordStageVersion(run, updated.stageVersion) ?? run) : run
  }
  const settle = async (
    run: CsvApplyContext,
    lease: CsvApplyLease | null,
    state: CsvApplyState,
    code: CsvApplyCode | null,
    attempts = run.attempts,
    nextAttemptAt: string | null = null,
  ) => {
    const current = runs.settle(run, lease, state, code, {
      attempts,
      failureChunk: code ? (runs.read(run.runId)?.committedRows ?? run.committedRows) : null,
      nextAttemptAt,
    })
    if (current) await updateStage(current)
    return current
  }
  return {
    runs,
    async tick(): Promise<{ runId: string; state: CsvApplyState } | null> {
      if (options.signal?.aborted) return null
      const initial = runs.listReady(1)[0]
      if (!initial) return null
      let run = initial
      let lease: CsvApplyLease | null = null
      try {
        if (run.nativeState === 'complete' || run.nativeState === 'cancelled') {
          const terminal = await settle(
            run,
            null,
            run.nativeState,
            run.nativeState === 'cancelled' ? 'cancelled_by_administrator' : null,
          )
          return { runId: run.runId, state: terminal?.state ?? run.nativeState }
        }
        const proof = runs.inspect(run)
        if (proof === 'stale_lease') return null
        if (proof !== 'ok') {
          await settle(run, null, 'paused', proof)
          return { runId: run.runId, state: 'paused' }
        }
        const actor = { kind: 'administrator' as const, userId: String(run.authority.userId) }
        const service = createSqliteCsvBrowserService(sqlite, {
          authorityFence: (current) => runs.executionFence(run, Number(current.userId)),
        })
        const claimed = await service.ledger.claimLease(actor, {
          runId: run.runId,
          holder: options.holder(),
          ttlMs: 60000,
        })
        if (claimed.outcome !== 'claimed') return null
        lease = {
          runId: run.runId,
          holder: claimed.lease.holder,
          generation: claimed.lease.generation,
        }
        run = runs.markRunning(run, lease)
        const bound = await staging.bindConfirmedRun(run.authority, binding(run))
        run = runs.recordStageVersion(run, bound.stageVersion) ?? run
        run = await updateStage(run)
        const input = await staging.loadOwnedPreview(run.authority, run.stageId, run.previewId)
        const native = await service.ledger.getRun(actor, run.runId)
        if (
          input.stale ||
          !native ||
          csvPlanId(csvBrowserSealInput(input.plan)) !== native.planId
        ) {
          await settle(run, lease, 'paused', 'policy_changed')
          return { runId: run.runId, state: 'paused' }
        }
        const writer = service.writer(input.snapshot, input.plan)
        const selected = input.plan.plan.items.filter((item) => item.state !== 'rejected')
        const maxRows = Math.max(1, Math.min(500, options.maxRows ?? 25))
        const maxMs = Math.max(1, Math.min(10000, options.maxTickMs ?? 4000))
        const started = now()
        let wrote = 0
        let cursor = runs.read(run.runId)!.committedRows
        while (
          !options.signal?.aborted &&
          cursor < selected.length &&
          wrote < maxRows &&
          now() - started < maxMs
        ) {
          await writer.writeRow(
            actor,
            { runId: run.runId, ...claimed.lease },
            native.planId,
            selected[cursor]!,
            cursor,
          )
          cursor++
          wrote++
        }
        // Retry custody resets only after durable cursor progress, never on setup replay.
        const progressed = cursor > initial.committedRows
        if (!options.signal?.aborted && cursor === selected.length) {
          await service.ledger.finish(actor, {
            runId: run.runId,
            planId: native.planId,
            holder: lease.holder,
            leaseGeneration: lease.generation,
            status: 'complete',
          })
          await settle(run, lease, 'complete', null, 0)
          return { runId: run.runId, state: 'complete' }
        }
        await settle(run, lease, 'queued', null, progressed ? 0 : run.attempts)
        return { runId: run.runId, state: 'queued' }
      } catch (cause) {
        const current = runs.read(run.runId)
        if (!current || current.commandId !== run.commandId) return null
        if (current.nativeState === 'cancelled') {
          await settle(current, null, 'cancelled', 'cancelled_by_administrator')
          return { runId: run.runId, state: 'cancelled' }
        }
        const proof = runs.inspect(current)
        if (proof === 'stale_lease') return null
        if (proof !== 'ok') {
          await settle(current, lease, 'paused', proof)
          return { runId: run.runId, state: 'paused' }
        }
        if (cause instanceof CsvBrowserLedgerRefusal && cause.code === 'stale_lease') return null
        let classified: CsvApplyCode | null | undefined
        try {
          classified = options.classifyError?.(cause)
        } catch {
          /* Keep the original failure and custody if classification itself fails. */
        }
        if (classified) {
          await settle(current, lease, 'paused', classified)
          return { runId: run.runId, state: 'paused' }
        }
        if (
          cause instanceof CsvBrowserLedgerRefusal ||
          cause instanceof CsvBrowserPlannerError ||
          cause instanceof CsvApplyRefusal
        ) {
          const code = cause instanceof CsvBrowserPlannerError ? 'parse_rejected' : 'policy_changed'
          await settle(current, lease, 'paused', code)
          return { runId: run.runId, state: 'paused' }
        }
        report(cause)
        const attempts = current.committedRows > initial.committedRows ? 1 : current.attempts + 1
        await settle(
          current,
          lease,
          'partial',
          'storage_unavailable',
          Math.min(3, attempts),
          attempts < 3 ? new Date(now() + 1000 * 2 ** attempts).toISOString() : null,
        )
        return { runId: run.runId, state: 'partial' }
      }
    },
  }
}
