import { issueScheduledReviewToken } from '@ezacto/core'
import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { createScheduledRunsService } from './scheduled-runs.js'
import {
  recordNotificationMail,
  readStrandedNotifications,
  type RecordedNotification,
} from './notification-mail.js'

const kind = 'scheduled_manifest'
/** Durable review notices. A link grants no authority and a GET never answers a run. */
export const prepareScheduledRunNotifications = async (
  database: InvoiceStateDatabase,
  input: {
    now: string
    appUrl: string
    reviewLinkSigningKey: Uint8Array
    from: { email: string; name?: string }
  },
): Promise<readonly RecordedNotification[]> => {
  const origin = new URL(input.appUrl).origin
  const messages: RecordedNotification[] = []
  const candidates = await database.all<{
    runId: number
    userId: number
    name: string
    email: string
  }>(sql`
    SELECT run.id AS runId, person.id AS userId, person.first_name || ' ' || person.last_name AS name,
      email.address AS email FROM proposed_runs run
    JOIN users person ON person.is_active=1 AND person.profile='administrator'
    JOIN user_emails email ON email.user_id=person.id AND email.is_primary=1
      AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
    WHERE run.state='proposed' AND run.expires_at>${input.now}
      AND NOT EXISTS(SELECT 1 FROM notification_deliveries notice
        WHERE notice.kind=${kind} AND notice.user_id=person.id AND notice.scope=CAST(run.id AS TEXT) AND notice.period=run.occurrence_key)
    ORDER BY run.id,person.id LIMIT 100`)
  const runs = createScheduledRunsService(database)
  for (const candidate of candidates) {
    const run = await runs.read(candidate.runId)
    if (run?.state !== 'proposed' || run.expires_at <= input.now) continue
    const lines = run.items.map((item) =>
      [
        item.client_name ?? item.description,
        item.description,
        ...(item.report_people ?? []).map(
          (person) => `${person.name}: ${(person.seconds / 3600).toFixed(2)} report hours`,
        ),
        item.quantity_seconds === null
          ? 'Invoice hours not recorded'
          : `${(item.quantity_seconds / 3600).toFixed(2)} invoice hours`,
        item.amount_cents === null
          ? 'Amount not recorded'
          : `${item.currency} ${(item.amount_cents / 100).toFixed(2)}`,
        `Target: ${item.target ?? 'not recorded'}`,
      ].join(' · '),
    )
    const review = await issueScheduledReviewToken(
      { runId: run.id, userId: candidate.userId, expiresAt: run.expires_at },
      input.reviewLinkSigningKey,
    )
    const recorded = await recordNotificationMail(
      database,
      {
        kind,
        userId: candidate.userId,
        scope: String(run.id),
        period: run.occurrence_key,
        from: input.from,
        to: { email: candidate.email, name: candidate.name.trim() },
        template: 'scheduled-manifest',
        subject: `Review month-end pack: ${run.occurrence_key}`,
        text: [
          `A month-end pack for ${run.occurrence_key} is waiting for an administrator's decision.`,
          ...lines,
          `Review and confirm or cancel: ${origin}/scheduled-runs/${run.id}#review=${review.token}`,
          `Answer before ${run.expires_at}. Without confirmation the proposal expires and nothing is sent.`,
          'Sign in to review the manifest. Opening or forwarding this link never confirms or executes anything.',
        ].join('\n\n'),
        related: { type: 'scheduled_run', id: run.id },
        now: input.now,
      },
      [
        {
          text: 'INSERT INTO scheduled_run_review_links(token_hash,run_id,user_id,expires_at,created_at) VALUES(?,?,?,?,?)',
          params: [review.hash, run.id, candidate.userId, run.expires_at, input.now],
        },
      ],
    )
    if (recorded.outcome === 'recorded') messages.push(recorded.notification)
  }
  // Queue interruption recovery uses the original recorded message and delivery ID.
  const stranded = await readStrandedNotifications(database, {
    kind,
    olderThan: new Date(Date.parse(input.now) - 60000).toISOString(),
  })
  for (const message of stranded) {
    if (messages.some((current) => current.deliveryId === message.deliveryId)) continue
    const authorized = await database.all<{
      id: number
    }>(sql`SELECT person.id FROM notification_deliveries notice
      JOIN users person ON person.id=notice.user_id AND person.is_active=1 AND person.profile='administrator'
      JOIN user_emails email ON email.user_id=person.id AND email.is_primary=1 AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
      WHERE notice.delivery_id=${message.deliveryId} AND email.address=${message.to.email}
        AND NOT EXISTS(SELECT 1 FROM scheduled_run_review_links link WHERE link.run_id=${message.related?.id ?? 0}
          AND link.user_id=person.id AND link.consumed_at IS NOT NULL)`)
    if (!authorized.length) continue
    const run = message.related ? await runs.read(message.related.id) : null
    if (run?.state === 'proposed' && run.expires_at > input.now) messages.push(message)
  }
  return messages
}
