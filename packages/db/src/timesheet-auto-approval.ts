import { sql } from 'drizzle-orm'
import { captureActivityEvent } from './activity-log.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import {
  createTimesheetApprovalRepository,
  TimesheetApprovalError,
} from './timesheet-approvals.js'

/**
 * Optional automatic approval of submitted timesheets (issue 1009).
 *
 * Off by default. When an administrator turns it on, a week that has sat
 * `submitted` for the configured number of calendar days is approved by the
 * sweep below. The clock is the week's `submitted_at`, which every submission
 * rewrites, so a rejected-and-resubmitted week starts again; and a week
 * submitted before the policy was switched on is never swept.
 *
 * The sweep decides nothing the manual path does not. It approves through
 * `bulkApprove` -- the version-checked, receipt-keyed approval -- so a manual
 * approval, rejection, withdrawal or resubmission that lands between "this week
 * looked due" and "approve it" bumps the version and the sweep's write finds
 * nothing to do.
 */

export const MINIMUM_AUTO_APPROVAL_DAYS = 1
export const MAXIMUM_AUTO_APPROVAL_DAYS = 60
const DAY_MS = 86_400_000
const DEFAULT_BATCH = 25

export interface TimesheetAutoApprovalSettings {
  readonly enabled: boolean
  /** Calendar days from `submitted_at`; null until an administrator chooses one. */
  readonly windowDays: number | null
  /** Weeks submitted before this are never swept; null while the policy is off. */
  readonly effectiveFrom: string | null
  /** The administrator whose standing authority the approval is recorded under. */
  readonly actorUserId: number | null
  /** The sweep does nothing while the Approval module is off. */
  readonly approvalModuleEnabled: boolean
}

interface SettingsRow {
  enabled: number
  windowDays: number | null
  effectiveFrom: string | null
  actorUserId: number | null
  moduleEnabled: number
  actorProfile: 'executive_manager' | 'administrator' | null
}

const readRow = async (database: InvoiceStateDatabase): Promise<SettingsRow> => {
  const [row] = await database.all<SettingsRow>(
    sql`SELECT organization.auto_approval_enabled AS enabled,
               organization.auto_approval_window_days AS windowDays,
               organization.auto_approval_effective_from AS effectiveFrom,
               organization.auto_approval_actor_user_id AS actorUserId,
               coalesce(json_extract(organization.modules, '$.approval'), 0) AS moduleEnabled,
               (SELECT actor.profile FROM users actor
                 WHERE actor.id = organization.auto_approval_actor_user_id
                   AND actor.is_active = 1
                   AND actor.profile IN ('administrator', 'executive_manager')) AS actorProfile
        FROM organizations organization WHERE organization.id = 1`,
  )
  if (row === undefined) throw new Error('Organization settings do not exist.')
  return row
}

const settings = (row: SettingsRow): TimesheetAutoApprovalSettings => ({
  enabled: row.enabled === 1,
  windowDays: row.windowDays,
  effectiveFrom: row.effectiveFrom,
  actorUserId: row.actorUserId,
  approvalModuleEnabled: row.moduleEnabled === 1,
})

export const readTimesheetAutoApproval = async (
  database: InvoiceStateDatabase,
): Promise<TimesheetAutoApprovalSettings> => settings(await readRow(database))

export interface TimesheetAutoApprovalPatch {
  readonly enabled?: boolean
  readonly windowDays?: number
}

/**
 * Applies a change and returns the policy as stored. Turning the policy on
 * stamps `effective_from` with `now`, so enabling is never retroactive; so does
 * turning it on again after it was off. Changing the window of a running policy
 * keeps `effective_from`: weeks already waiting are measured against the new
 * window. The acting administrator becomes the sweep's recorded approver.
 */
export const updateTimesheetAutoApproval = async (
  database: InvoiceStateDatabase,
  actorUserId: number,
  patch: TimesheetAutoApprovalPatch,
  now: string,
): Promise<TimesheetAutoApprovalSettings> => {
  if (
    patch.windowDays !== undefined &&
    (!Number.isInteger(patch.windowDays) ||
      patch.windowDays < MINIMUM_AUTO_APPROVAL_DAYS ||
      patch.windowDays > MAXIMUM_AUTO_APPROVAL_DAYS)
  ) {
    throw new RangeError(
      `window_days must be a whole number from ${MINIMUM_AUTO_APPROVAL_DAYS} to ${MAXIMUM_AUTO_APPROVAL_DAYS}`,
    )
  }
  const current = await readRow(database)
  const enabled = patch.enabled ?? current.enabled === 1
  const windowDays = patch.windowDays ?? current.windowDays
  if (enabled && windowDays === null) {
    throw new RangeError('choose a window in days before turning automatic approval on')
  }
  const effectiveFrom = !enabled ? null : current.enabled === 1 ? current.effectiveFrom : now
  await database.run(
    sql`UPDATE organizations
        SET auto_approval_enabled = ${enabled ? 1 : 0},
            auto_approval_window_days = ${windowDays},
            auto_approval_effective_from = ${effectiveFrom},
            auto_approval_actor_user_id = ${enabled ? actorUserId : null},
            updated_at = ${now}
        WHERE id = 1`,
  )
  return readTimesheetAutoApproval(database)
}

export interface TimesheetAutoApprovalRun {
  /** Submissions this run approved. */
  readonly approved: readonly number[]
  /** Due weeks that something else had already settled, or another run took. */
  readonly skipped: number
  /** One entry per submission that could not be handled; never silent. */
  readonly failed: readonly { readonly submissionId: number; readonly message: string }[]
  /** Why the run ended before its batch was done, if it did. */
  readonly stopped?: 'disabled' | 'changed' | 'module_disabled' | 'approver_unavailable'
}

interface Due {
  id: number
  version: number
  userId: number
  periodStart: string
  periodEnd: string
  submittedAt: string
}

/**
 * Approves up to `batchSize` due weeks, oldest first. Safe to run from every
 * tick and from two places at once: each approval is keyed by the submission and
 * the version it was seen at, so a second run finds the receipt (or the changed
 * version) and counts a skip.
 *
 * The policy is read again before every approval, so switching it off, or
 * changing it, stops a run that is part way through. A submitter who has been
 * archived is not swept.
 */
export const runTimesheetAutoApproval = async (
  database: InvoiceStateDatabase,
  now: string,
  options: { readonly batchSize?: number } = {},
): Promise<TimesheetAutoApprovalRun> => {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  const start = await readRow(database)
  const idle = (stopped?: TimesheetAutoApprovalRun['stopped']): TimesheetAutoApprovalRun => ({
    approved: [],
    skipped: 0,
    failed: [],
    ...(stopped === undefined ? {} : { stopped }),
  })
  if (start.enabled !== 1 || start.windowDays === null || start.effectiveFrom === null) {
    return idle()
  }
  if (start.moduleEnabled !== 1) return idle('module_disabled')
  if (start.actorProfile === null || start.actorUserId === null) {
    return idle('approver_unavailable')
  }

  const cutoff = new Date(Date.parse(now) - start.windowDays * DAY_MS).toISOString()
  const due = await database.all<Due>(
    sql`SELECT submission.id AS id, submission.version AS version,
               submission.user_id AS userId, submission.period_start AS periodStart,
               submission.period_end AS periodEnd, submission.submitted_at AS submittedAt
        FROM timesheet_submissions submission
        JOIN users submitter ON submitter.id = submission.user_id
        WHERE submission.status = 'submitted' AND submission.origin = 'native'
          AND submission.submitted_at IS NOT NULL
          AND submission.submitted_at <= ${cutoff}
          AND submission.submitted_at >= ${start.effectiveFrom}
          AND submitter.is_active = 1
        ORDER BY submission.submitted_at, submission.id
        LIMIT ${batchSize}`,
  )

  const approvals = createTimesheetApprovalRepository(database)
  const approved: number[] = []
  const failed: { submissionId: number; message: string }[] = []
  let skipped = 0
  let stopped: TimesheetAutoApprovalRun['stopped']
  for (const week of due) {
    const live = await readRow(database)
    if (live.enabled !== 1) {
      stopped = 'disabled'
      break
    }
    if (
      live.windowDays !== start.windowDays ||
      live.effectiveFrom !== start.effectiveFrom ||
      live.actorUserId !== start.actorUserId
    ) {
      stopped = 'changed'
      break
    }
    if (live.actorProfile === null) {
      stopped = 'approver_unavailable'
      break
    }
    try {
      await approvals.bulkApprove(
        { userId: live.actorUserId!, profile: live.actorProfile },
        `auto-approval:${week.id}:${week.version}`,
        [{ submissionId: week.id, expectedVersion: week.version }],
        now,
      )
    } catch (error) {
      if (error instanceof TimesheetApprovalError) {
        if (error.code === 'state_conflict' || error.code === 'not_found') {
          skipped += 1
          continue
        }
        if (error.code === 'module_disabled') {
          stopped = 'module_disabled'
          break
        }
      }
      failed.push({
        submissionId: week.id,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    approved.push(week.id)
    try {
      await captureActivityEvent(database, {
        eventType: 'timesheet.auto_approved',
        subjectId: week.id,
        actor: { type: 'system' },
        occurredAt: now,
        captureId: `auto-approval:${week.id}:${week.version}`,
        detail: {
          user_id: week.userId,
          period_start: week.periodStart,
          period_end: week.periodEnd,
          submitted_at: week.submittedAt,
          window_days: start.windowDays,
          recorded_under_user_id: live.actorUserId,
        },
      })
    } catch (error) {
      failed.push({
        submissionId: week.id,
        message: `approved, but the activity record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  }
  return { approved, skipped, failed, ...(stopped === undefined ? {} : { stopped }) }
}
