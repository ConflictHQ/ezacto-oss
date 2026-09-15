import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { resolveEntryRates } from './rate-resolver.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
export type ReportTimeAction = 'mark_invoiced' | 'mark_uninvoiced' | 'move'

export interface ReportTimeActionInput {
  commandId: string
  actorUserId: number
  action: ReportTimeAction
  entryIds: readonly number[]
  invoiceId?: number
  projectId?: number
  taskId?: number
  completedAt: string
}

export interface ReportTimeActionResult {
  readonly commandId: string
  readonly action: ReportTimeAction
  readonly requested: number
  readonly changedEntryIds: readonly number[]
  readonly ineligibleEntryIds: readonly number[]
  readonly replayed: boolean
}

type Entry = {
  id: number
  userId: number
  projectId: number
  taskId: number
  spentDate: string
  invoiceId: number | null
  timerStartedAt: string | null
  approvalStatus: string
  updatedAt: string
}

const normalized = (input: ReportTimeActionInput) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.commandId)) throw new RangeError('commandId is invalid')
  const entryIds = [...new Set(input.entryIds)]
  if (entryIds.length === 0 || entryIds.length > 1000 || entryIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new RangeError('entryIds must contain 1 to 1000 positive integers')
  }
  entryIds.sort((left, right) => left - right)
  if (input.action === 'mark_invoiced' && (!Number.isSafeInteger(input.invoiceId) || input.invoiceId! < 1)) {
    throw new RangeError('invoiceId is required when marking invoiced')
  }
  if (input.action === 'move' && (
    !Number.isSafeInteger(input.projectId) || input.projectId! < 1 ||
    !Number.isSafeInteger(input.taskId) || input.taskId! < 1
  )) throw new RangeError('projectId and taskId are required when moving time')
  return { ...input, entryIds }
}

export const executeReportTimeAction = async (
  database: Database,
  raw: Readonly<ReportTimeActionInput>,
): Promise<ReportTimeActionResult | 'command_conflict' | 'invoice_unavailable'> => {
  const input = normalized(raw)
  const fingerprint = JSON.stringify({
    action: input.action,
    entryIds: input.entryIds,
    invoiceId: input.invoiceId ?? null,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
  })
  const prior = await database.all<{ fingerprint: string; resultJson: string }>(sql`
    SELECT fingerprint, result_json AS "resultJson" FROM report_time_commands
    WHERE command_id = ${input.commandId}`)
  if (prior[0] !== undefined) {
    if (prior[0].fingerprint !== fingerprint) return 'command_conflict'
    return { ...(JSON.parse(prior[0].resultJson) as ReportTimeActionResult), replayed: true }
  }

  if (input.action === 'mark_invoiced') {
    const invoice = await database.all<{ state: string }>(sql`
      SELECT state FROM invoices WHERE id = ${input.invoiceId!}`)
    if (invoice[0]?.state !== 'draft') return 'invoice_unavailable'
  }

  const requested = sql.join(input.entryIds.map((id) => sql`${id}`), sql`, `)
  const entries = await database.all<Entry>(sql`
    SELECT id, user_id AS "userId", project_id AS "projectId", task_id AS "taskId",
      spent_date AS "spentDate", invoice_id AS "invoiceId",
      timer_started_at AS "timerStartedAt", approval_status AS "approvalStatus",
      updated_at AS "updatedAt"
    FROM time_entries WHERE id IN (${requested}) ORDER BY id`)
  const changed: number[] = []

  for (const entry of entries) {
    if (entry.timerStartedAt !== null) continue
    if (input.action === 'mark_invoiced') {
      if (entry.invoiceId !== null) continue
      const eligible = await database.all<{ id: number }>(sql`
        SELECT entry.id FROM time_entries entry
        JOIN projects project ON project.id = entry.project_id
        JOIN invoices invoice ON invoice.id = ${input.invoiceId!}
        WHERE entry.id = ${entry.id} AND entry.invoice_id IS NULL AND entry.billable = 1
          AND entry.timer_started_at IS NULL AND invoice.state = 'draft'
          AND invoice.client_id = project.client_id`)
      if (eligible[0] === undefined) continue
      await database.run(sql`UPDATE time_entries SET invoice_id = ${input.invoiceId!}, updated_at = ${input.completedAt}
        WHERE id = ${entry.id} AND invoice_id IS NULL AND updated_at = ${entry.updatedAt}`)
      changed.push(entry.id)
    } else if (input.action === 'mark_uninvoiced') {
      if (entry.invoiceId === null) continue
      const eligible = await database.all<{ id: number }>(sql`
        SELECT entry.id FROM time_entries entry JOIN invoices invoice ON invoice.id = entry.invoice_id
        WHERE entry.id = ${entry.id} AND invoice.state NOT IN ('open','paid')`)
      if (eligible[0] === undefined) continue
      await database.run(sql`UPDATE time_entries SET invoice_id = NULL, updated_at = ${input.completedAt}
        WHERE id = ${entry.id} AND invoice_id = ${entry.invoiceId} AND updated_at = ${entry.updatedAt}`)
      changed.push(entry.id)
    } else {
      if (entry.invoiceId !== null || entry.approvalStatus !== 'unsubmitted') continue
      const assignments = await database.all<{ userAssignmentId: number; taskAssignmentId: number; billable: number }>(sql`
        SELECT user_assignment.id AS "userAssignmentId", task_assignment.id AS "taskAssignmentId",
          task_assignment.billable
        FROM user_assignments user_assignment JOIN task_assignments task_assignment
          ON task_assignment.project_id = user_assignment.project_id
        WHERE user_assignment.user_id = ${entry.userId}
          AND user_assignment.project_id = ${input.projectId!}
          AND task_assignment.task_id = ${input.taskId!}
          AND user_assignment.is_active = 1 AND task_assignment.is_active = 1`)
      const assignment = assignments[0]
      if (assignment === undefined) continue
      const rates = await resolveEntryRates(database, {
        userId: entry.userId,
        projectId: input.projectId!,
        taskId: input.taskId!,
        userAssignmentId: assignment.userAssignmentId,
        taskAssignmentId: assignment.taskAssignmentId,
        spentDate: entry.spentDate,
      })
      await database.run(sql`UPDATE time_entries SET project_id = ${input.projectId!}, task_id = ${input.taskId!},
        user_assignment_id = ${assignment.userAssignmentId}, task_assignment_id = ${assignment.taskAssignmentId},
        billable = ${assignment.billable}, billable_rate_cents = ${rates.billableRateCents},
        cost_rate_cents = ${rates.costRateCents}, updated_at = ${input.completedAt}
        WHERE id = ${entry.id} AND invoice_id IS NULL AND timer_started_at IS NULL
          AND approval_status = 'unsubmitted' AND updated_at = ${entry.updatedAt}`)
      changed.push(entry.id)
    }
  }

  const changedSet = new Set(changed)
  const result: ReportTimeActionResult = {
    commandId: input.commandId,
    action: input.action,
    requested: input.entryIds.length,
    changedEntryIds: changed,
    ineligibleEntryIds: input.entryIds.filter((id) => !changedSet.has(id)),
    replayed: false,
  }
  await database.run(sql`INSERT INTO report_time_commands
    (command_id, actor_user_id, fingerprint, action, result_json, completed_at)
    VALUES (${input.commandId}, ${input.actorUserId}, ${fingerprint}, ${input.action},
      ${JSON.stringify(result)}, ${input.completedAt})`)
  return result
}
