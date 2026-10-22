import { consumeScheduledReviewLink } from './scheduled-review-links.js'
import { sql } from 'drizzle-orm'
import type { ScheduledRun, ScheduledRunOutcome, ScheduledRunsService } from '@ezacto/core'
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
    report_name: item.report?.name ?? null,
    report_warnings: item.reportWarnings ?? [],
    report_people: item.reportPeople ?? [],
    attempt_limit: item.attemptLimit ?? 3,
    delivery_id: null,
    delivery_status: null,
  })),
})

/** The administrator-facing read, confirm and cancel of a proposed run. */
export const createScheduledRunsService = (
  database: ActionDatabase,
  options: { reviewLinkSigningKey?: Uint8Array } = {},
): ScheduledRunsService => {
  const store = createScheduledActionStore(database)
  const read = async (id: number): Promise<ScheduledRun | null> => {
    const run = await store.read(id)
    if (run === null) return null
    const shown = present(run, await store.manifest(id))
    const deliveries = await database.all<{ itemId: number; deliveryId: number; status: string }>(
      sql`SELECT receipt.run_item_id AS itemId,receipt.delivery_id AS deliveryId,log.status FROM scheduled_run_deliveries receipt JOIN run_items item ON item.id=receipt.run_item_id JOIN email_log log ON log.id=receipt.delivery_id WHERE item.run_id=${id}`,
    )
    for (const item of shown.items) {
      const delivery = deliveries.find((record) => record.itemId === item.id)
      item.delivery_id = delivery?.deliveryId ?? null
      item.delivery_status = delivery?.status ?? null
    }
    return shown
  }
  const refused = async (
    id: number,
    outcome: 'not_found' | 'expired' | 'not_proposed',
  ): Promise<ScheduledRunOutcome> => {
    const run = await read(id)
    return run === null ? { outcome } : { outcome, run }
  }
  return {
    ...(options.reviewLinkSigningKey
      ? {
          consumeReviewLink: (id: number, userId: number, token: string, now: string) =>
            consumeScheduledReviewLink(
              database,
              options.reviewLinkSigningKey!,
              id,
              userId,
              token,
              now,
            ),
        }
      : {}),
    read,
    readReport: async (id, itemId) => {
      const item = (await store.manifest(id)).find((item) => item.id === itemId)
      return item?.report ? { key: item.report.key, name: item.report.name } : null
    },
    retry: async (id, userId, now) => {
      await database.run(sql`UPDATE run_items SET attempt_limit=attempt_count+3,retry_requested_by_user_id=${userId},retry_requested_at=${now}
        WHERE run_id=${id} AND state='failed' AND attempt_count>=attempt_limit
          AND EXISTS(SELECT 1 FROM proposed_runs WHERE id=${id} AND state='confirmed')
          AND EXISTS(SELECT 1 FROM users WHERE id=${userId} AND is_active=1 AND profile='administrator')`)
      const actor = await database.all<{ id: number }>(
        sql`SELECT id FROM users WHERE id=${userId} AND is_active=1 AND profile='administrator'`,
      )
      const run = await read(id)
      if (run === null) return { outcome: 'not_found' }
      return actor.length && run.state === 'confirmed'
        ? { outcome: 'ok', run }
        : { outcome: 'not_proposed', run }
    },
    confirm: async (id, userId, now, acknowledgeReportWarnings) => {
      const result = await store.confirm(id, userId, now, acknowledgeReportWarnings)
      if (result.outcome === 'report_warnings_unacknowledged')
        return { outcome: result.outcome, run: (await read(id))! }
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
