import type { ReportNoteWarning } from './report-note-visibility.js'
/**
 * The manifest of a proposed run, as an administrator reads and answers it (issue 61).
 *
 * The store in `@ezacto/db` owns the state machine; this is what crosses the
 * API: the run with its concrete items, and an outcome that says why an answer
 * was refused rather than only that it was.
 */

export type ScheduledRunState = 'proposed' | 'confirmed' | 'cancelled' | 'expired' | 'completed'

export interface ScheduledReportPerson {
  id: number
  name: string
  seconds: number
}
export interface ScheduledRunItem {
  report_people?: readonly ScheduledReportPerson[]
  report_name?: string | null
  report_warnings?: readonly ReportNoteWarning[]
  attempt_limit?: number
  delivery_id?: number | null
  delivery_status?: string | null
  id: number
  subject_type: string
  subject_id: number
  description: string
  amount_cents: number | null
  currency: string | null
  target: string | null
  quantity_seconds: number | null
  client_name: string | null
  state: 'pending' | 'running' | 'done' | 'failed'
  attempt_count: number
  failure_reason: string | null
  completed_at: string | null
}

export interface ScheduledRun {
  id: number
  job_id: number
  occurrence_key: string
  state: ScheduledRunState
  proposed_at: string
  expires_at: string
  confirmed_by: number | null
  confirmed_at: string | null
  settled_reason: string | null
  items: ScheduledRunItem[]
}

export type ScheduledRunOutcome =
  | { outcome: 'ok'; run: ScheduledRun }
  | {
      outcome: 'not_found' | 'expired' | 'not_proposed' | 'report_warnings_unacknowledged'
      run?: ScheduledRun
    }

export interface ScheduledRunsService {
  readReport?(id: number, itemId: number): Promise<{ key: string; name: string } | null>
  retry?(id: number, userId: number, now: string): Promise<ScheduledRunOutcome>
  read(id: number): Promise<ScheduledRun | null>
  /** Confirming a run that is already confirmed returns it unchanged. */
  confirm(
    id: number,
    userId: number,
    now: string,
    acknowledgeReportWarnings?: boolean,
  ): Promise<ScheduledRunOutcome>
  /** Cancelling a run that is already cancelled returns it unchanged. */
  cancel(id: number, userId: number, now: string): Promise<ScheduledRunOutcome>
}
