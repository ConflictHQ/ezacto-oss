import type {
  ScheduledRun,
  ScheduledRunOutcome,
  ScheduledRunsService,
} from '@ezacto/core'
import {
  createScheduledActionStore,
  type ProposedRunRecord,
  type RunItemRecord,
} from './scheduled-actions.js'

type ActionDatabase = Parameters<typeof createScheduledActionStore>[0]

const present = (run: ProposedRunRecord, items: readonly RunItemRecord[]): ScheduledRun => ({
  id: run.id,
  job_id: run.jobId,
  occurrence_key: run.occurrenceKey,
  state: run.state,
  proposed_at: run.proposedAt,
  expires_at: run.expiresAt,
  confirmed_by: run.confirmedByUserId,
  confirmed_at: run.confirmedAt,
  settled_reason: run.settledReason,
  items: items.map((item) => ({
    id: item.id,
    subject_type: item.subjectType,
    subject_id: item.subjectId,
    description: item.description,
    amount_cents: item.amountCents,
    currency: item.currency,
    target: item.target,
    quantity_seconds: item.quantitySeconds,
    client_name: item.clientName,
    state: item.state,
    attempt_count: item.attemptCount,
    failure_reason: item.failureReason,
    completed_at: item.completedAt,
  })),
})

/** The administrator-facing read, confirm and cancel of a proposed run. */
export const createScheduledRunsService = (database: ActionDatabase): ScheduledRunsService => {
  const store = createScheduledActionStore(database)
  const read = async (id: number): Promise<ScheduledRun | null> => {
    const run = await store.read(id)
    return run === null ? null : present(run, await store.manifest(id))
  }
  const refused = async (
    id: number,
    outcome: 'not_found' | 'expired' | 'not_proposed',
  ): Promise<ScheduledRunOutcome> => {
    const run = await read(id)
    return run === null ? { outcome } : { outcome, run }
  }
  return {
    read,
    confirm: async (id, userId, now) => {
      const result = await store.confirm(id, userId, now)
      if (result.outcome === 'confirmed') return { outcome: 'ok', run: (await read(id))! }
      if (result.outcome === 'expired') {
        // Settle it now rather than leave it to the sweep, so the run a caller
        // is told about is the run that can never be confirmed.
        await store.expire(now)
        return refused(id, 'expired')
      }
      if (result.outcome === 'unknown_run') return { outcome: 'not_found' }
      // A second confirm is a no-op: the run is as the first one left it.
      const run = await read(id)
      if (run !== null && (run.state === 'confirmed' || run.state === 'completed'))
        return { outcome: 'ok', run }
      return refused(id, 'not_proposed')
    },
    cancel: async (id, userId, now) => {
      if (await store.cancel(id, now, `cancelled by user ${userId}`, userId))
        return { outcome: 'ok', run: (await read(id))! }
      const run = await read(id)
      if (run === null) return { outcome: 'not_found' }
      if (run.state === 'cancelled') return { outcome: 'ok', run }
      if (run.state === 'proposed' && run.expires_at <= now) {
        await store.expire(now)
        return refused(id, 'expired')
      }
      return refused(id, 'not_proposed')
    },
  }
}
