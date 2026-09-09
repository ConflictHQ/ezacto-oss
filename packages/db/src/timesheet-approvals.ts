import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type ApprovalDatabase =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

export type TimesheetSubmissionStatus = 'unsubmitted' | 'submitted' | 'approved'


/**
 * The reason stored when someone takes back their own week. The CHECK on
 * `timesheet_submissions` requires every unsubmitted row to carry a reason, and
 * this is the one that means "nobody rejected this, the owner withdrew it" --
 * which callers can also tell from the reviewer being the owner.
 */
export const SELF_WITHDRAWAL_REASON = 'Taken back by the owner before review.'

export interface TimesheetApprovalActor {
  userId: number
  profile:
    | 'member'
    | 'project_manager'
    | 'people_admin'
    | 'accounting'
    | 'executive_manager'
    | 'administrator'
}

export interface TimesheetSubmissionRecord {
  id: number
  userId: number
  userName: string
  periodStart: string
  periodEnd: string
  status: TimesheetSubmissionStatus
  origin: 'native' | 'harvest_import' | 'legacy_backfill'
  sourceStatus: 'submitted' | 'approved' | null
  sourceObservedAt: string | null
  submittedByUserId: number | null
  submittedAt: string | null
  reviewedByUserId: number | null
  reviewedAt: string | null
  rejectionReason: string | null
  version: number
  entryCount: number
  expenseCount: number
  totalSeconds: number
  billableSeconds: number
  nonbillableSeconds: number
  createdAt: string
  updatedAt: string
}

export interface TimesheetSubmissionEntryRecord {
  id: number
  spentDate: string
  projectId: number
  projectName: string
  taskId: number
  taskName: string
  seconds: number
  notes: string | null
}

export interface TimesheetSubmissionExpenseRecord {
  id: number
  spentDate: string
  projectId: number
  projectName: string
  expenseCategoryId: number
  expenseCategoryName: string
  totalCostCents: number
  currency: string
  notes: string | null
}

export interface TimesheetSubmissionDetailRecord extends TimesheetSubmissionRecord {
  entries: readonly TimesheetSubmissionEntryRecord[]
  expenses: readonly TimesheetSubmissionExpenseRecord[]
}

export interface TimesheetBulkApprovalSelection {
  submissionId: number
  /** The version the approver was looking at when they chose this submission. */
  expectedVersion: number
}

export interface TimesheetSubmissionFilters {
  periodStart?: string
  periodEnd?: string
  userId?: number
  clientId?: number
  projectId?: number
}

export interface ApprovalListWindow {
  afterId: number | null
  throughId: number
  take: number
}

export interface TimesheetSubmissionSource {
  highWatermark(): Promise<number | null>
  list(window: ApprovalListWindow): Promise<readonly TimesheetSubmissionRecord[]>
}

export type TimesheetApprovalErrorCode =
  | 'module_disabled'
  | 'not_found'
  | 'forbidden'
  | 'empty_period'
  | 'running_entry'
  | 'period_overlap'
  | 'state_conflict'

export class TimesheetApprovalError extends Error {
  constructor(
    readonly code: TimesheetApprovalErrorCode,
    message: string,
    /**
     * The selections a bulk approval refused, so the caller can hand them back
     * to the approver rather than dropping them. Empty for single-submission
     * failures, where the submission in the route is the one that failed.
     */
    readonly submissionIds: readonly number[] = [],
  ) {
    super(message)
    this.name = 'TimesheetApprovalError'
  }
}

interface RawSubmissionRow {
  id: number
  user_id: number
  user_name: string
  period_start: string
  period_end: string
  status: TimesheetSubmissionStatus
  origin: 'native' | 'harvest_import' | 'legacy_backfill'
  source_status: 'submitted' | 'approved' | null
  source_observed_at: string | null
  submitted_by_user_id: number | null
  submitted_at: string | null
  reviewed_by_user_id: number | null
  reviewed_at: string | null
  rejection_reason: string | null
  version: number
  entry_count: number
  expense_count: number
  total_seconds: number
  billable_seconds: number
  nonbillable_seconds: number
  created_at: string
  updated_at: string
}

interface RawSubmissionDetailRow extends RawSubmissionRow {
  item_kind: 'time' | 'expense' | null
  item_id: number | null
  item_spent_date: string | null
  item_project_id: number | null
  item_project_name: string | null
  item_task_id: number | null
  item_task_name: string | null
  item_expense_category_id: number | null
  item_expense_category_name: string | null
  item_seconds: number | null
  item_total_cost_cents: number | null
  item_currency: string | null
  item_notes: string | null
}

interface AtomicPairResult {
  mutationRows: Record<string, unknown>[]
  readRows: RawSubmissionRow[]
}

const approvalEnabledSql = `COALESCE(
  (SELECT json_extract(modules, '$.approval') FROM organizations WHERE id = 1),
  0
) = 1`

const submissionProjection = `submission.id,
  submission.user_id,
  trim(user.first_name || ' ' || coalesce(user.last_name, '')) AS user_name,
  submission.period_start,
  submission.period_end,
  submission.status,
  submission.origin,
  submission.source_status,
  submission.source_observed_at,
  submission.submitted_by_user_id,
  submission.submitted_at,
  submission.reviewed_by_user_id,
  submission.reviewed_at,
  submission.rejection_reason,
  submission.version,
  (SELECT count(*) FROM time_entries entry
    WHERE entry.timesheet_submission_id = submission.id) AS entry_count,
  (SELECT count(*) FROM expenses expense
    WHERE expense.timesheet_submission_id = submission.id) AS expense_count,
  coalesce((SELECT sum(entry.seconds) FROM time_entries entry
    WHERE entry.timesheet_submission_id = submission.id), 0) AS total_seconds,
  coalesce((SELECT sum(entry.seconds) FROM time_entries entry
    WHERE entry.timesheet_submission_id = submission.id AND entry.billable = 1), 0)
    AS billable_seconds,
  coalesce((SELECT sum(entry.seconds) FROM time_entries entry
    WHERE entry.timesheet_submission_id = submission.id AND entry.billable = 0), 0)
    AS nonbillable_seconds,
  submission.created_at,
  submission.updated_at`

const submissionSelect = `SELECT ${submissionProjection}
  FROM timesheet_submissions submission
  JOIN users user ON user.id = submission.user_id`

const submissionDetailSelect = `WITH detail_item AS (
  SELECT 'time' AS item_kind, entry.id AS item_id, entry.timesheet_submission_id,
    entry.spent_date AS item_spent_date, entry.project_id AS item_project_id,
    project.name AS item_project_name, entry.task_id AS item_task_id,
    task.name AS item_task_name, NULL AS item_expense_category_id,
    NULL AS item_expense_category_name, entry.seconds AS item_seconds,
    NULL AS item_total_cost_cents, NULL AS item_currency, entry.notes AS item_notes
  FROM time_entries entry
  JOIN projects project ON project.id = entry.project_id
  JOIN tasks task ON task.id = entry.task_id
  UNION ALL
  SELECT 'expense', expense.id, expense.timesheet_submission_id,
    expense.spent_date, expense.project_id, project.name, NULL, NULL,
    expense.expense_category_id, category.name, NULL, expense.total_cost_cents,
    upper(coalesce(project.billing_currency, client.currency)), expense.notes
  FROM expenses expense
  JOIN projects project ON project.id = expense.project_id
  JOIN clients client ON client.id = project.client_id
  JOIN expense_categories category ON category.id = expense.expense_category_id
)
SELECT ${submissionProjection},
  detail_item.item_kind,
  detail_item.item_id,
  detail_item.item_spent_date,
  detail_item.item_project_id,
  detail_item.item_project_name,
  detail_item.item_task_id,
  detail_item.item_task_name,
  detail_item.item_expense_category_id,
  detail_item.item_expense_category_name,
  detail_item.item_seconds,
  detail_item.item_total_cost_cents,
  detail_item.item_currency,
  detail_item.item_notes
FROM timesheet_submissions submission
JOIN users user ON user.id = submission.user_id
LEFT JOIN detail_item ON detail_item.timesheet_submission_id = submission.id`

const nativeClient = (database: ApprovalDatabase): NativeClient =>
  (database as ApprovalDatabase & { $client: NativeClient }).$client

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

const atomicPair = async (
  client: NativeClient,
  mutation: { sql: string; params: readonly unknown[] },
  read: { sql: string; params: readonly unknown[] },
): Promise<AtomicPairResult> => {
  if (isD1Client(client)) {
    const [mutationResult, readResult] = await client.batch([
      client.prepare(mutation.sql).bind(...mutation.params),
      client.prepare(read.sql).bind(...read.params),
    ])
    return {
      mutationRows: (mutationResult?.results ?? []) as Record<string, unknown>[],
      readRows: (readResult?.results ?? []) as unknown as RawSubmissionRow[],
    }
  }
  const execute = client.transaction(() => ({
    mutationRows: client.prepare(mutation.sql).all(...mutation.params) as Record<
      string,
      unknown
    >[],
    readRows: client.prepare(read.sql).all(...read.params) as RawSubmissionRow[],
  }))
  return execute.immediate()
}

/**
 * The N-statement form of `atomicPair`. Bulk approval needs every statement to
 * land or none to, so the container path runs one immediate transaction and the
 * D1 path uses `batch()`, which is itself one transaction that rolls back whole
 * when any statement in it fails. Every statement must return rows -- the
 * container driver refuses `all()` on one that does not -- so callers add
 * RETURNING to their mutations.
 */
const atomicBatch = async (
  client: NativeClient,
  statements: readonly { sql: string; params: readonly unknown[] }[],
): Promise<Record<string, unknown>[][]> => {
  if (isD1Client(client)) {
    const results = await client.batch(
      statements.map((statement) => client.prepare(statement.sql).bind(...statement.params)),
    )
    return results.map((result) => (result.results ?? []) as Record<string, unknown>[])
  }
  const execute = client.transaction(() =>
    statements.map(
      (statement) =>
        client.prepare(statement.sql).all(...statement.params) as Record<string, unknown>[],
    ),
  )
  return execute.immediate()
}

const first = async <Row>(
  client: NativeClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row | null> => {
  if (isD1Client(client)) return client.prepare(sql).bind(...params).first<Row>()
  return (client.prepare(sql).get(...params) as Row | undefined) ?? null
}

const all = async <Row>(
  client: NativeClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row[]> => {
  if (isD1Client(client)) {
    return (await client.prepare(sql).bind(...params).all<Row>()).results
  }
  return client.prepare(sql).all(...params) as Row[]
}

const record = (row: RawSubmissionRow): TimesheetSubmissionRecord => ({
  id: row.id,
  userId: row.user_id,
  userName: row.user_name,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  status: row.status,
  origin: row.origin,
  sourceStatus: row.source_status,
  sourceObservedAt: row.source_observed_at,
  submittedByUserId: row.submitted_by_user_id,
  submittedAt: row.submitted_at,
  reviewedByUserId: row.reviewed_by_user_id,
  reviewedAt: row.reviewed_at,
  rejectionReason: row.rejection_reason,
  version: row.version,
  entryCount: row.entry_count,
  expenseCount: row.expense_count,
  totalSeconds: row.total_seconds,
  billableSeconds: row.billable_seconds,
  nonbillableSeconds: row.nonbillable_seconds,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const approverPredicate = (actor: Readonly<TimesheetApprovalActor>): {
  sql: string
  params: readonly unknown[]
} => {
  if (actor.profile === 'administrator' || actor.profile === 'executive_manager') {
    return { sql: '1 = 1', params: [] }
  }
  if (actor.profile === 'project_manager') {
    return {
      sql: `EXISTS (
        SELECT 1 FROM teammate_assignments assignment
        WHERE assignment.manager_id = ? AND assignment.user_id = submission.user_id
      )`,
      params: [actor.userId],
    }
  }
  return { sql: '0 = 1', params: [] }
}

const listConditions = (
  filters: Readonly<TimesheetSubmissionFilters>,
): { sql: string[]; params: unknown[] } => {
  const sql: string[] = []
  const params: unknown[] = []
  if (filters.periodStart !== undefined) {
    sql.push('submission.period_start >= ?')
    params.push(filters.periodStart)
  }
  if (filters.periodEnd !== undefined) {
    sql.push('submission.period_end <= ?')
    params.push(filters.periodEnd)
  }
  if (filters.userId !== undefined) {
    sql.push('submission.user_id = ?')
    params.push(filters.userId)
  }
  if (filters.clientId !== undefined) {
    sql.push(`EXISTS (
      SELECT 1 FROM time_entries te
      JOIN projects p ON p.id = te.project_id
      WHERE te.timesheet_submission_id = submission.id AND p.client_id = ?
      UNION ALL
      SELECT 1 FROM expenses ex
      JOIN projects p ON p.id = ex.project_id
      WHERE ex.timesheet_submission_id = submission.id AND p.client_id = ?
    )`)
    params.push(filters.clientId, filters.clientId)
  }
  if (filters.projectId !== undefined) {
    sql.push(`EXISTS (
      SELECT 1 FROM time_entries te
      WHERE te.timesheet_submission_id = submission.id AND te.project_id = ?
      UNION ALL
      SELECT 1 FROM expenses ex
      WHERE ex.timesheet_submission_id = submission.id AND ex.project_id = ?
    )`)
    params.push(filters.projectId, filters.projectId)
  }
  return { sql, params }
}

const sqliteMessage = (error: unknown): string =>
  error instanceof Error ? error.message.toLocaleLowerCase('en-US') : ''

const translateMutationFailure = (error: unknown): never => {
  const message = sqliteMessage(error)
  if (message.includes('module is disabled')) {
    throw new TimesheetApprovalError('module_disabled', 'Timesheet approvals are not enabled.')
  }
  if (message.includes('period overlaps')) {
    throw new TimesheetApprovalError(
      'period_overlap',
      'The requested period overlaps another timesheet submission.',
    )
  }
  if (message.includes('running time entries')) {
    throw new TimesheetApprovalError(
      'running_entry',
      'Stop running time entries before submitting this period.',
    )
  }
  if (message.includes('no unsubmitted entries')) {
    throw new TimesheetApprovalError(
      'empty_period',
      'The requested period has no unsubmitted time or expense entries.',
    )
  }
  if (message.includes('period changed before approval')) {
    throw new TimesheetApprovalError(
      'state_conflict',
      'The timesheet period changed before it could be approved.',
    )
  }
  throw error
}

export class TimesheetApprovalRepository {
  readonly #client: NativeClient

  constructor(database: ApprovalDatabase) {
    this.#client = nativeClient(database)
  }

  async #assertEnabled(): Promise<void> {
    const enabled = await first<{ enabled: number }>(
      this.#client,
      `SELECT CASE WHEN ${approvalEnabledSql} THEN 1 ELSE 0 END AS enabled`,
    )
    if (enabled?.enabled !== 1) {
      throw new TimesheetApprovalError('module_disabled', 'Timesheet approvals are not enabled.')
    }
  }

  async assertEnabled(): Promise<void> {
    await this.#assertEnabled()
  }

  async #canReview(
    actor: Readonly<TimesheetApprovalActor>,
    userId: number,
  ): Promise<boolean> {
    if (actor.profile === 'administrator' || actor.profile === 'executive_manager') return true
    if (actor.profile !== 'project_manager') return false
    return (
      (await first<{ allowed: number }>(
        this.#client,
        `SELECT 1 AS allowed FROM teammate_assignments
         WHERE manager_id = ? AND user_id = ?`,
        [actor.userId, userId],
      )) !== null
    )
  }

  async get(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
  ): Promise<TimesheetSubmissionDetailRecord> {
    const authorization = approverPredicate(actor)
    const rows = await all<RawSubmissionDetailRow>(
      this.#client,
      `${submissionDetailSelect}
       WHERE ${approvalEnabledSql} AND submission.id = ?
         AND (submission.user_id = ? OR ${authorization.sql})
       ORDER BY detail_item.item_spent_date, detail_item.item_kind, detail_item.item_id`,
      [submissionId, actor.userId, ...authorization.params],
    )
    const row = rows[0]
    if (row === undefined) {
      await this.#assertEnabled()
      const existing = await first<{ user_id: number }>(
        this.#client,
        `SELECT user_id FROM timesheet_submissions WHERE id = ?`,
        [submissionId],
      )
      if (existing === null) {
        throw new TimesheetApprovalError('not_found', 'The timesheet submission does not exist.')
      }
      throw new TimesheetApprovalError(
        'forbidden',
        'The acting user cannot view this timesheet submission.',
      )
    }
    const entries = rows.flatMap((detail): TimesheetSubmissionEntryRecord[] => {
      if (
        detail.item_kind !== 'time' ||
        detail.item_id === null ||
        detail.item_spent_date === null ||
        detail.item_project_id === null ||
        detail.item_project_name === null ||
        detail.item_task_id === null ||
        detail.item_task_name === null ||
        detail.item_seconds === null
      ) return []
      return [
        {
          id: detail.item_id,
          spentDate: detail.item_spent_date,
          projectId: detail.item_project_id,
          projectName: detail.item_project_name,
          taskId: detail.item_task_id,
          taskName: detail.item_task_name,
          seconds: detail.item_seconds,
          notes: detail.item_notes,
        },
      ]
    })
    const expenses = rows.flatMap((detail): TimesheetSubmissionExpenseRecord[] => {
      if (
        detail.item_kind !== 'expense' ||
        detail.item_id === null ||
        detail.item_spent_date === null ||
        detail.item_project_id === null ||
        detail.item_project_name === null ||
        detail.item_expense_category_id === null ||
        detail.item_expense_category_name === null ||
        detail.item_total_cost_cents === null ||
        detail.item_currency === null
      ) return []
      if (!/^[A-Z]{3}$/.test(detail.item_currency)) {
        throw new Error('Timesheet submission expense currency is invalid.')
      }
      return [{
        id: detail.item_id,
        spentDate: detail.item_spent_date,
        projectId: detail.item_project_id,
        projectName: detail.item_project_name,
        expenseCategoryId: detail.item_expense_category_id,
        expenseCategoryName: detail.item_expense_category_name,
        totalCostCents: detail.item_total_cost_cents,
        currency: detail.item_currency,
        notes: detail.item_notes,
      }]
    })
    return { ...record(row), entries, expenses }
  }

  async #exact(userId: number, periodStart: string, periodEnd: string) {
    const row = await first<RawSubmissionRow>(
      this.#client,
      `${submissionSelect}
       WHERE submission.user_id = ? AND submission.period_start = ? AND submission.period_end = ?`,
      [userId, periodStart, periodEnd],
    )
    return row === null ? null : record(row)
  }

  ownSubmissions(
    userId: number,
    filters: Readonly<TimesheetSubmissionFilters>,
  ): TimesheetSubmissionSource {
    const conditions = listConditions(filters)
    const base = ['submission.user_id = ?', ...conditions.sql]
    const params = [userId, ...conditions.params]
    return this.#source(base, params)
  }

  pendingSubmissions(
    actor: Readonly<TimesheetApprovalActor>,
    filters: Readonly<TimesheetSubmissionFilters>,
  ): TimesheetSubmissionSource {
    const authorization = approverPredicate(actor)
    const conditions = listConditions(filters)
    return this.#source(
      ["submission.status = 'submitted'", authorization.sql, ...conditions.sql],
      [...authorization.params, ...conditions.params],
    )
  }

  approvedSubmissions(
    actor: Readonly<TimesheetApprovalActor>,
    filters: Readonly<TimesheetSubmissionFilters>,
  ): TimesheetSubmissionSource {
    const authorization = approverPredicate(actor)
    const conditions = listConditions(filters)
    return this.#source(
      ["submission.status = 'approved'", authorization.sql, ...conditions.sql],
      [...authorization.params, ...conditions.params],
    )
  }

  #source(conditions: readonly string[], params: readonly unknown[]): TimesheetSubmissionSource {
    const where = conditions.length === 0 ? '1 = 1' : conditions.join(' AND ')
    return {
      highWatermark: async () => {
        await this.#assertEnabled()
        const row = await first<{ id: number }>(
          this.#client,
          `SELECT submission.id FROM timesheet_submissions submission
           WHERE ${where} ORDER BY submission.id DESC LIMIT 1`,
          params,
        )
        return row?.id ?? null
      },
      list: async ({ afterId, throughId, take }) => {
        await this.#assertEnabled()
        const rows = await all<RawSubmissionRow>(
          this.#client,
          `${submissionSelect}
           WHERE ${where} AND submission.id <= ?
             ${afterId === null ? '' : 'AND submission.id > ?'}
           ORDER BY submission.id ASC LIMIT ?`,
          [
            ...params,
            throughId,
            ...(afterId === null ? [] : [afterId]),
            take,
          ],
        )
        return rows.map(record)
      },
    }
  }

  async submit(
    userId: number,
    periodStart: string,
    periodEnd: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord> {
    try {
      const result = await atomicPair(
        this.#client,
        {
          sql: `INSERT INTO timesheet_submissions (
              user_id, period_start, period_end, status, submitted_by_user_id,
              submitted_at, reviewed_by_user_id, reviewed_at, rejection_reason,
              version, created_at, updated_at
            )
            SELECT ?, ?, ?, 'submitted', ?, ?, NULL, NULL, NULL, 0, ?, ?
            FROM organizations organization
            WHERE organization.id = 1 AND ${approvalEnabledSql}
              AND NOT EXISTS (
                SELECT 1 FROM time_entries entry
                WHERE entry.user_id = ? AND entry.spent_date BETWEEN ? AND ?
                  AND (entry.timer_started_at IS NOT NULL
                    OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL))
              )
              AND EXISTS (
                SELECT 1 FROM time_entries entry
                WHERE entry.user_id = ? AND entry.spent_date BETWEEN ? AND ?
                  AND entry.approval_status = 'unsubmitted'
                UNION ALL
                SELECT 1 FROM expenses expense
                WHERE expense.user_id = ? AND expense.spent_date BETWEEN ? AND ?
                  AND expense.approval_status = 'unsubmitted'
              )
            ON CONFLICT(user_id, period_start, period_end) DO UPDATE SET
              status = 'submitted', submitted_at = excluded.submitted_at,
              submitted_by_user_id = excluded.submitted_by_user_id,
              reviewed_by_user_id = NULL, reviewed_at = NULL, rejection_reason = NULL,
              version = timesheet_submissions.version + 1, updated_at = excluded.updated_at
            WHERE timesheet_submissions.status = 'unsubmitted'
            RETURNING id`,
          params: [
            userId,
            periodStart,
            periodEnd,
            userId,
            occurredAt,
            occurredAt,
            occurredAt,
            userId,
            periodStart,
            periodEnd,
            userId,
            periodStart,
            periodEnd,
            userId,
            periodStart,
            periodEnd,
          ],
        },
        {
          sql: `${submissionSelect}
            WHERE submission.user_id = ? AND submission.period_start = ?
              AND submission.period_end = ?`,
          params: [userId, periodStart, periodEnd],
        },
      )
      if (result.mutationRows.length > 0 && result.readRows[0]) {
        return record(result.readRows[0])
      }
    } catch (error) {
      translateMutationFailure(error)
    }

    await this.#assertEnabled()
    const existing = await this.#exact(userId, periodStart, periodEnd)
    if (existing !== null && existing.status !== 'unsubmitted') {
      throw new TimesheetApprovalError(
        'state_conflict',
        `This period is already ${existing.status}.`,
      )
    }
    const running = await first<{ present: number }>(
      this.#client,
      `SELECT 1 AS present FROM time_entries
       WHERE user_id = ? AND spent_date BETWEEN ? AND ?
         AND (timer_started_at IS NOT NULL OR (started_time IS NOT NULL AND ended_time IS NULL))
       LIMIT 1`,
      [userId, periodStart, periodEnd],
    )
    if (running !== null) {
      throw new TimesheetApprovalError(
        'running_entry',
        'Stop running time entries before submitting this period.',
      )
    }
    throw new TimesheetApprovalError(
      'empty_period',
      'The requested period has no unsubmitted time or expense entries.',
    )
  }

  async approve(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord> {
    return this.#review(actor, submissionId, occurredAt, null)
  }

  async reject(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord> {
    return this.#review(actor, submissionId, occurredAt, reason)
  }

  /**
   * Approves an explicit set of submissions as one command, all or none.
   *
   * Every selection is reauthorized here, at mutation time, against the same
   * predicate the single-submission route uses -- the profile check the caller
   * did before this is a courtesy, not the authority. The receipt row is what
   * enforces it: `timesheet_bulk_approval_command_items.submission_id` is NOT
   * NULL and is filled from a subquery that yields a row only for a submission
   * that is still submitted, still at the version the approver saw, and still
   * reviewable by this actor. An ineligible selection therefore fails its
   * INSERT, which fails the transaction, which leaves every other selection
   * exactly as it was.
   */
  async bulkApprove(
    actor: Readonly<TimesheetApprovalActor>,
    commandId: string,
    selections: readonly TimesheetBulkApprovalSelection[],
    occurredAt: string,
  ): Promise<readonly TimesheetSubmissionRecord[]> {
    const authorization = approverPredicate(actor)
    const identifiers = selections.map((selection) => selection.submissionId)
    try {
      const results = await atomicBatch(this.#client, [
        {
          sql: `INSERT INTO timesheet_bulk_approval_commands (
              command_id, actor_user_id, submission_count, occurred_at
            ) VALUES (?, ?, ?, ?) RETURNING command_id`,
          params: [commandId, actor.userId, selections.length, occurredAt],
        },
        ...selections.map((selection) => ({
          sql: `INSERT INTO timesheet_bulk_approval_command_items (
              command_id, submission_id, expected_version
            ) VALUES (?, (
              SELECT submission.id FROM timesheet_submissions submission
              WHERE submission.id = ? AND submission.version = ?
                AND submission.status = 'submitted'
                AND ${approvalEnabledSql} AND ${authorization.sql}
            ), ?) RETURNING submission_id`,
          params: [
            commandId,
            selection.submissionId,
            selection.expectedVersion,
            ...authorization.params,
            selection.expectedVersion,
          ],
        })),
        ...selections.map((selection) => ({
          sql: `UPDATE timesheet_submissions AS submission
            SET status = 'approved', reviewed_by_user_id = ?, reviewed_at = ?,
              rejection_reason = NULL, version = version + 1, updated_at = ?
            WHERE submission.id = ? AND submission.version = ?
              AND submission.status = 'submitted'
            RETURNING id`,
          params: [
            actor.userId,
            occurredAt,
            occurredAt,
            selection.submissionId,
            selection.expectedVersion,
          ],
        })),
        {
          sql: `${submissionSelect}
            WHERE submission.id IN (${identifiers.map(() => '?').join(', ')})
            ORDER BY submission.id`,
          params: identifiers,
        },
      ])
      const rows = (results[results.length - 1] ?? []) as unknown as RawSubmissionRow[]
      const approved = rows.filter((row) => row.status === 'approved')
      if (approved.length === selections.length) return approved.map(record)
    } catch (error) {
      return this.#bulkFailure(actor, commandId, selections, error)
    }
    return this.#bulkFailure(actor, commandId, selections, null)
  }

  /**
   * Says which selections were refused, after the fact. The mutation deals in a
   * single failed statement, so this re-reads the set and names the offenders
   * the way `#review` names a single one -- an approver retrying a batch needs
   * to know which rows to look at, not that "something" was stale.
   */
  async #bulkFailure(
    actor: Readonly<TimesheetApprovalActor>,
    commandId: string,
    selections: readonly TimesheetBulkApprovalSelection[],
    cause: unknown,
  ): Promise<never> {
    await this.#assertEnabled()
    const identifiers = selections.map((selection) => selection.submissionId)
    // A surviving receipt can only be an earlier command: this one's rolled back
    // with the rest of its batch. Checked first because a replayed identity
    // explains the failure exactly, and the selections themselves may look fine.
    const replayed = await first<{ command_id: string }>(
      this.#client,
      `SELECT command_id FROM timesheet_bulk_approval_commands WHERE command_id = ?`,
      [commandId],
    )
    if (replayed !== null) {
      throw new TimesheetApprovalError(
        'state_conflict',
        'This bulk approval command identity has already been used.',
        identifiers,
      )
    }
    const placeholders = identifiers.map(() => '?').join(', ')
    const existing = await all<{ id: number; status: TimesheetSubmissionStatus; version: number }>(
      this.#client,
      `SELECT id, status, version FROM timesheet_submissions WHERE id IN (${placeholders})`,
      identifiers,
    )
    const present = new Map(existing.map((row) => [row.id, row]))
    const missing = identifiers.filter((id) => !present.has(id))
    if (missing.length > 0) {
      throw new TimesheetApprovalError(
        'not_found',
        'A selected timesheet submission does not exist.',
        missing,
      )
    }
    const authorization = approverPredicate(actor)
    const reviewable = new Set(
      (
        await all<{ id: number }>(
          this.#client,
          `SELECT submission.id FROM timesheet_submissions submission
           WHERE submission.id IN (${placeholders}) AND ${authorization.sql}`,
          [...identifiers, ...authorization.params],
        )
      ).map((row) => row.id),
    )
    const forbidden = identifiers.filter((id) => !reviewable.has(id))
    if (forbidden.length > 0) {
      throw new TimesheetApprovalError(
        'forbidden',
        'The acting user cannot review every selected timesheet submission.',
        forbidden,
      )
    }
    const stale = selections
      .filter((selection) => {
        const row = present.get(selection.submissionId)!
        return row.status !== 'submitted' || row.version !== selection.expectedVersion
      })
      .map((selection) => selection.submissionId)
    if (stale.length > 0) {
      throw new TimesheetApprovalError(
        'state_conflict',
        'A selected timesheet submission changed before it could be approved.',
        stale,
      )
    }
    if (cause !== null) translateMutationFailure(cause)
    throw new TimesheetApprovalError(
      'state_conflict',
      'The selected timesheet submissions changed before they could be approved.',
      identifiers,
    )
  }

  /**
   * A person taking back their own week before anyone has reviewed it.
   *
   * Distinct from `withdraw`, which undoes an approval and is an administrator
   * act. Nothing is undone here except the person's own submission, so the
   * check is ownership rather than profile. The state machine already allows
   * this transition -- `timesheet_submissions_update_guard` requires a
   * privileged actor only for `approved -> unsubmitted`.
   *
   * The row records the person as the one who sent it back, because the table
   * CHECK requires every unsubmitted row to say who did it and why, and here
   * the honest answer to both is the owner. Reviewers and the person's own
   * screen tell this from a rejection by comparing the reviewer to the owner;
   * `SELF_WITHDRAWAL_REASON` is the recognisable form. Giving this its own
   * null-reviewer state would mean a fourth branch on that CHECK, which SQLite
   * can only reach by rebuilding the table and its eleven triggers -- worth
   * doing, and not worth doing in the same change as the feature.
   *
   * Only a submission still waiting. An approved week has been acted on by
   * someone else and stays the administrator's to reopen.
   */
  async unsubmit(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord> {
    try {
      const result = await atomicPair(
        this.#client,
        {
          // Ownership and status are both in the predicate rather than read
          // first: a read-then-write pair could approve between the two, and
          // the write would then quietly undo a decision it never saw.
          sql: `UPDATE timesheet_submissions AS submission
            SET status = 'unsubmitted', reviewed_by_user_id = submission.user_id,
              reviewed_at = ?, rejection_reason = ?,
              version = version + 1, updated_at = ?
            WHERE submission.id = ? AND submission.user_id = ?
              AND submission.status = 'submitted'
            RETURNING id`,
          params: [
            occurredAt,
            SELF_WITHDRAWAL_REASON,
            occurredAt,
            submissionId,
            actor.userId,
          ],
        },
        { sql: `${submissionSelect} WHERE submission.id = ?`, params: [submissionId] },
      )
      if (result.mutationRows.length > 0 && result.readRows[0]) {
        return record(result.readRows[0])
      }
    } catch (error) {
      translateMutationFailure(error)
    }

    const existing = await first<{ status: TimesheetSubmissionStatus; user_id: number }>(
      this.#client,
      `SELECT status, user_id FROM timesheet_submissions WHERE id = ?`,
      [submissionId],
    )
    if (existing === null) {
      throw new TimesheetApprovalError('not_found', 'The timesheet submission does not exist.')
    }
    // Someone else's submission answers the same way a missing one does. Saying
    // "that is not yours" confirms it exists and who it belongs to.
    if (existing.user_id !== actor.userId) {
      throw new TimesheetApprovalError('not_found', 'The timesheet submission does not exist.')
    }
    throw new TimesheetApprovalError(
      'state_conflict',
      existing.status === 'approved'
        ? 'An approved timesheet can only be reopened by an administrator.'
        : 'Only a submitted timesheet can be unsubmitted.',
    )
  }

  async withdraw(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord> {
    if (actor.profile !== 'administrator' && actor.profile !== 'executive_manager') {
      throw new TimesheetApprovalError(
        'forbidden',
        'Only an organization policy administrator can withdraw an approval.',
      )
    }
    try {
      const result = await atomicPair(
        this.#client,
        {
          sql: `UPDATE timesheet_submissions AS submission
            SET status = 'unsubmitted', reviewed_by_user_id = ?, reviewed_at = ?,
              rejection_reason = ?, version = version + 1, updated_at = ?
            WHERE submission.id = ? AND submission.status = 'approved'
            RETURNING id`,
          params: [actor.userId, occurredAt, reason, occurredAt, submissionId],
        },
        { sql: `${submissionSelect} WHERE submission.id = ?`, params: [submissionId] },
      )
      if (result.mutationRows.length > 0 && result.readRows[0]) {
        return record(result.readRows[0])
      }
    } catch (error) {
      translateMutationFailure(error)
    }

    const existing = await first<{ status: TimesheetSubmissionStatus }>(
      this.#client,
      `SELECT status FROM timesheet_submissions WHERE id = ?`,
      [submissionId],
    )
    if (existing === null) {
      throw new TimesheetApprovalError('not_found', 'The timesheet submission does not exist.')
    }
    throw new TimesheetApprovalError(
      'state_conflict',
      'Only an approved timesheet can have its approval withdrawn.',
    )
  }

  async #review(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
    occurredAt: string,
    rejectionReason: string | null,
  ): Promise<TimesheetSubmissionRecord> {
    const authorization = approverPredicate(actor)
    try {
      const result = await atomicPair(
        this.#client,
        {
          sql: `UPDATE timesheet_submissions AS submission
            SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?,
              rejection_reason = ?, version = version + 1, updated_at = ?
            WHERE submission.id = ? AND submission.status = 'submitted'
              AND ${approvalEnabledSql} AND ${authorization.sql}
            RETURNING id`,
          params: [
            rejectionReason === null ? 'approved' : 'unsubmitted',
            actor.userId,
            occurredAt,
            rejectionReason,
            occurredAt,
            submissionId,
            ...authorization.params,
          ],
        },
        {
          sql: `${submissionSelect} WHERE submission.id = ?`,
          params: [submissionId],
        },
      )
      if (result.mutationRows.length > 0 && result.readRows[0]) {
        return record(result.readRows[0])
      }
    } catch (error) {
      translateMutationFailure(error)
    }

    await this.#assertEnabled()
    const existing = await first<{ id: number; status: TimesheetSubmissionStatus; user_id: number }>(
      this.#client,
      `SELECT id, status, user_id FROM timesheet_submissions WHERE id = ?`,
      [submissionId],
    )
    if (existing === null) {
      throw new TimesheetApprovalError('not_found', 'The timesheet submission does not exist.')
    }
    if (!(await this.#canReview(actor, existing.user_id))) {
      throw new TimesheetApprovalError(
        'forbidden',
        'The acting user cannot review this timesheet submission.',
      )
    }
    throw new TimesheetApprovalError(
      'state_conflict',
      `Only a submitted timesheet can be ${rejectionReason === null ? 'approved' : 'rejected'}.`,
    )
  }
}

export const createTimesheetApprovalRepository = (
  database: ApprovalDatabase,
): TimesheetApprovalRepository => new TimesheetApprovalRepository(database)
