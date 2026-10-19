/**
 * Storage for the Deel time sync (issue 103): the transfer log, the run lock
 * and the reads that feed the planner. The rules live in
 * `@ezacto/integrations`; this file is only what they ask of a database.
 *
 * "Paid through Deel" is a per-person choice (`staff_payment_provider_events`),
 * so the entries read here are those of people whose effective provider is
 * Deel -- their own setting, else the organization default, else Wise. A
 * contractor paid through Wise never has a timesheet created for them at Deel.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type {
  DeelSyncSource,
  DirectoryEmail,
  EmailKind,
  LoggedTransfer,
  TransferLogRecord,
  TransferTimeEntry,
} from '@ezacto/integrations'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

/**
 * A run that has not finished after this long is taken to have died. Workers
 * are cut off far sooner, so a lock older than this is a crash, not a run.
 */
export const DEEL_SYNC_STALE_RUN_MS = 60 * 60 * 1000

const deelPayees = sql`
  SELECT u.id FROM users u
  WHERE u.is_active = 1
    AND COALESCE(
      (SELECT e.provider FROM staff_payment_provider_events e
        WHERE e.scope = 'user:' || u.id ORDER BY e.version DESC LIMIT 1),
      (SELECT e.provider FROM staff_payment_provider_events e
        WHERE e.scope = 'organization' ORDER BY e.version DESC LIMIT 1),
      'wise') = 'deel'`

/**
 * Approved, finished time of Deel-paid people inside the window. Approval is
 * the gate: hours a manager has not signed off are not hours to pay for.
 */
const eligibleEntries = (window: { from: string; to: string }) => sql`
  SELECT t.id FROM time_entries t
  WHERE t.approval_status = 'approved'
    AND t.timer_started_at IS NULL
    AND (t.started_time IS NULL OR t.ended_time IS NOT NULL)
    AND t.spent_date >= ${window.from} AND t.spent_date <= ${window.to}
    AND t.user_id IN (${deelPayees})`

interface LoggedRow {
  entry_id: number
  fingerprint: string
  timesheet_id: string
  user_id: number | null
  spent_date: string | null
  rounded_seconds: number | null
}

export interface DeelSyncRunRecord {
  id: number
  startedAt: string
  finishedAt: string | null
  outcome: 'running' | 'completed' | 'failed'
  timesheetsSubmitted: number
  entriesTransferred: number
  detail: unknown
}

export interface DeelSyncStore extends DeelSyncSource {
  /** Newest first. */
  recentRuns(limit: number): Promise<readonly DeelSyncRunRecord[]>
}

export const createDeelSyncStore = (database: Database): DeelSyncStore => ({
  directory: async () => {
    const rows = await database.all<{ user_id: number; address: string; kind: EmailKind | null }>(sql`
      SELECT email.user_id, email.address, email.kind FROM user_emails email
      WHERE email.invalidated_at IS NULL AND email.verified_at IS NOT NULL
        AND email.user_id IN (${deelPayees})
      ORDER BY email.user_id, email.id`)
    const byUser = new Map<number, DirectoryEmail[]>()
    for (const row of rows) {
      // An address with no kind is not a payroll address, and the matcher only
      // reads payroll ones; it is kept out rather than defaulted to a kind.
      if (row.kind === null) continue
      const emails = byUser.get(row.user_id) ?? []
      emails.push({ address: row.address, kind: row.kind })
      byUser.set(row.user_id, emails)
    }
    const payees = await database.all<{ id: number }>(deelPayees)
    return payees.map((payee) => ({ userId: payee.id, emails: byUser.get(payee.id) ?? [] }))
  },

  entries: async (window) => {
    const rows = await database.all<{
      id: number
      user_id: number
      spent_date: string
      rounded_seconds: number
    }>(sql`
      SELECT id, user_id, spent_date, rounded_seconds FROM time_entries
      WHERE id IN (${eligibleEntries(window)})
      ORDER BY spent_date, id`)
    return rows.map(
      (row): TransferTimeEntry => ({
        id: row.id,
        userId: row.user_id,
        spentDate: row.spent_date,
        roundedSeconds: row.rounded_seconds,
      }),
    )
  },

  log: async (window) => {
    const rows = await database.all<{ entry_id: number; fingerprint: string; timesheet_id: string }>(sql`
      SELECT entry_id, fingerprint, timesheet_id FROM deel_transfer_log
      WHERE entry_id IN (${eligibleEntries(window)})
      ORDER BY entry_id`)
    return rows.map(
      (row): TransferLogRecord => ({
        entryId: row.entry_id,
        fingerprint: row.fingerprint,
        timesheetId: row.timesheet_id,
      }),
    )
  },

  logged: async () => {
    const rows = await database.all<LoggedRow>(sql`
      SELECT log.entry_id, log.fingerprint, log.timesheet_id,
        t.user_id, t.spent_date, t.rounded_seconds
      FROM deel_transfer_log log
      LEFT JOIN time_entries t ON t.id = log.entry_id
      ORDER BY log.entry_id`)
    return rows.map(
      (row): LoggedTransfer => ({
        entryId: row.entry_id,
        fingerprint: row.fingerprint,
        timesheetId: row.timesheet_id,
        current:
          row.user_id === null || row.spent_date === null || row.rounded_seconds === null
            ? null
            : {
                id: row.entry_id,
                userId: row.user_id,
                spentDate: row.spent_date,
                roundedSeconds: row.rounded_seconds,
              },
      }),
    )
  },

  /**
   * Insert-or-refuse: the primary key is the arbiter, so a second record for
   * an entry that is already logged fails loudly instead of overwriting the
   * first. A caller that sees that error has just sent hours twice.
   */
  record: async (record, now) => {
    await database.all(sql`
      INSERT INTO deel_transfer_log (entry_id, fingerprint, timesheet_id, transferred_at)
      VALUES (${record.entryId}, ${record.fingerprint}, ${record.timesheetId}, ${now})
      RETURNING entry_id`)
  },

  beginRun: async (now) => {
    const staleBefore = new Date(Date.parse(now) - DEEL_SYNC_STALE_RUN_MS).toISOString()
    await database.all(sql`
      UPDATE deel_sync_runs
      SET outcome = 'failed', finished_at = ${now},
        detail = json_object('error',
          'abandoned: the run never finished, so a timesheet may have been created at Deel without a log record. Check Deel before the next run is trusted.')
      WHERE outcome = 'running' AND started_at < ${staleBefore}
      RETURNING id`)
    const inserted = await database.all<{ id: number }>(sql`
      INSERT INTO deel_sync_runs (started_at, outcome) VALUES (${now}, 'running')
      ON CONFLICT DO NOTHING RETURNING id`)
    return inserted[0]?.id ?? null
  },

  finishRun: async (id, outcome, summary, now) => {
    await database.all(sql`
      UPDATE deel_sync_runs
      SET outcome = ${outcome}, finished_at = ${now},
        timesheets_submitted = ${summary.timesheetsSubmitted},
        entries_transferred = ${summary.entriesTransferred},
        detail = ${JSON.stringify(summary.detail)}
      WHERE id = ${id} AND outcome = 'running'
      RETURNING id`)
  },

  recentRuns: async (limit) => {
    const rows = await database.all<{
      id: number
      started_at: string
      finished_at: string | null
      outcome: 'running' | 'completed' | 'failed'
      timesheets_submitted: number
      entries_transferred: number
      detail: string | null
    }>(sql`
      SELECT id, started_at, finished_at, outcome, timesheets_submitted,
        entries_transferred, detail
      FROM deel_sync_runs ORDER BY id DESC LIMIT ${limit}`)
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome,
      timesheetsSubmitted: row.timesheets_submitted,
      entriesTransferred: row.entries_transferred,
      detail: row.detail === null ? null : (JSON.parse(row.detail) as unknown),
    }))
  },
})
