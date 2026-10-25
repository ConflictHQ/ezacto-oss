import type BetterSqlite3 from 'better-sqlite3'
import { sql, type SQL } from 'drizzle-orm'
import {
  TimeEntryNoteRequirementError,
  TrackedMutationLockedError,
  TrackedResourceAssignmentError,
  TrackedResourceInputError,
} from '@ezacto/core'
import {
  createCsvImportStore,
  createContainerDatabase,
  createGeneralResourceRepository,
  createTimesheetLockPolicyRepository,
  DrizzleTrackedResourceRepository,
  isDuplicateCsvImportKey,
  type CsvImportRun,
} from '@ezacto/db'
import { parseCsv, type CsvAdapter } from './csv-contract.js'
import { type CsvMapping } from './csv-mapping.js'

/**
 * The CSV time import (issue 1012, slices 1 and 2): `planCsvImport` reads a file
 * against a database and reports what applying it would do, changing nothing;
 * `applyCsvImport` does it, idempotently.
 *
 * Time is written through the same path the API uses (`createTimeEntry`), so
 * rounding, rates from this instance's assignments, timesheet locks, approvals
 * and note rules all apply. Nothing here writes an invoice, payment or expense,
 * and an entry that exists is never edited: a row whose source key is already
 * recorded is skipped, which is also what keeps a re-run from touching time that
 * has since been invoiced.
 *
 * Abort means "stop reading further rows". It is not a rollback: entries already
 * written stay, and the run is left resumable.
 */

type Database = ReturnType<typeof createContainerDatabase>

export type { EntityKind, EntityTally, RejectedRow, CsvImportReport } from './csv-planner.js'
import {
  resolveCsvPlan,
  type Entity,
  type CsvImportReport,
  type RejectedRow,
  type ClientRow,
  type ProjectRow,
  type TaskRow,
} from './csv-planner.js'
const rowsOf = async <T>(database: Database, query: SQL): Promise<T[]> =>
  (await database.all<T>(query)) as T[]

export const planCsvImport = async (
  database: Database,
  bytes: Uint8Array,
  options: { sourceId: string; mapping?: CsvMapping; adapter?: CsvAdapter },
) => {
  const parsed = parseCsv(bytes, options.adapter)
  const store = createCsvImportStore(database)
  const available = await store.available()
  const stored = available ? await store.findRun(options.sourceId, parsed.sha256) : null
  // Keep the CLI's early refusal before requiring any destination catalog.
  if (parsed.fileErrors.length > 0)
    return resolveCsvPlan(
      parsed,
      {
        organization: { time_entry_mode: 'duration', currency: '' },
        stored,
        emails: [],
        clients: [],
        projects: [],
        tasks: [],
        userAssignments: [],
        taskAssignments: [],
        submissions: [],
        importedKeys: [],
        lockedDates: [],
      },
      options,
    )
  const [organization] = await rowsOf<{ time_entry_mode: string; currency: string }>(
    database,
    sql`SELECT time_entry_mode, currency FROM organizations WHERE id=1`,
  )
  if (!organization) throw new Error('The database has no organization to import into.')
  const [emails, clients, projects, tasks, userAssignments, taskAssignments, submissions] =
    await Promise.all([
      rowsOf<{ email: string; user_id: number }>(
        database,
        sql`SELECT lower(address) AS email,user_id FROM user_emails WHERE verified_at IS NOT NULL AND invalidated_at IS NULL`,
      ),
      rowsOf<ClientRow>(database, sql`SELECT id,name,is_active,currency FROM clients`),
      rowsOf<ProjectRow>(database, sql`SELECT id,client_id,name,is_active FROM projects`),
      rowsOf<TaskRow>(database, sql`SELECT id,name,is_active,billable_by_default FROM tasks`),
      rowsOf<{ user_id: number; project_id: number; is_active: number }>(
        database,
        sql`SELECT user_id,project_id,is_active FROM user_assignments`,
      ),
      rowsOf<{ project_id: number; task_id: number; billable: number; is_active: number }>(
        database,
        sql`SELECT project_id,task_id,billable,is_active FROM task_assignments`,
      ),
      rowsOf<{ user_id: number; period_start: string; period_end: string; status: string }>(
        database,
        sql`SELECT user_id,period_start,period_end,status FROM timesheet_submissions WHERE status IN ('submitted','approved')`,
      ),
    ])
  const importedKeys = available ? [...(await store.importedKeys(options.sourceId))] : []
  // Existing CLI behavior: native policy resolves/materializes overdue windows.
  const snapshot = {
    organization,
    stored,
    emails,
    clients,
    projects,
    tasks,
    userAssignments,
    taskAssignments,
    submissions,
    importedKeys,
    lockedDates: [] as string[],
  }
  const provisional = resolveCsvPlan(parsed, snapshot, options)
  const dates = provisional.policyDates
  const locked = await createTimesheetLockPolicyRepository(database).lockedDates(dates)
  return resolveCsvPlan(
    parsed,
    { ...snapshot, lockedDates: [...locked].filter(([, value]) => value).map(([date]) => date) },
    options,
  )
}

/**
 * The dry run: the plan, inside a transaction that is always rolled back, so
 * that nothing the planning read path might record survives it.
 */
export const dryRunCsvImport = async (
  sqlite: BetterSqlite3.Database,
  bytes: Uint8Array,
  options: { sourceId: string; mapping?: CsvMapping; adapter?: CsvAdapter },
): Promise<CsvImportReport> => {
  sqlite.exec('BEGIN')
  try {
    return (await planCsvImport(createContainerDatabase(sqlite), bytes, options)).report
  } finally {
    sqlite.exec('ROLLBACK')
  }
}

export interface ApplyOptions {
  sourceId: string
  mapping?: CsvMapping
  /** Reads a vendor's export into the contract (see `csv-toggl.ts`). */
  adapter?: CsvAdapter
  /** Apply the rows that can be applied and leave the rest listed. */
  skipRejected?: boolean
  /** Checked between rows; aborting stops further rows and rolls nothing back. */
  signal?: AbortSignal
  now?: () => Date
}

export interface ApplyResult {
  /** `refused` wrote nothing; the others are the state the run was left in. */
  status: 'refused' | CsvImportRun['status']
  reason?: string
  report: CsvImportReport
  created: number
  alreadyImported: number
  rejected: number
  error?: string
}

const boundaryAt = (date: Date) => {
  const instant = date.toISOString()
  return { instant, date: instant.slice(0, 10), time: instant.slice(11, 16) }
}

const domainRejection = (error: unknown): { code: string; message: string } | null => {
  if (error instanceof TrackedMutationLockedError)
    return { code: 'period_locked', message: error.message }
  if (error instanceof TrackedResourceAssignmentError)
    return { code: 'assignment_unavailable', message: error.message }
  if (error instanceof TrackedResourceInputError)
    return { code: error.reasonCode, message: error.message }
  if (error instanceof TimeEntryNoteRequirementError)
    return { code: 'notes_required', message: error.message }
  return null
}

/**
 * Apply a file. Idempotent by construction: every row carries a source key, the
 * key is recorded in the same batch as the entry it created, and a recorded key
 * is skipped. Stop it anywhere, or let it fail, and running it again finishes
 * the remainder only, under the mapping the run was started with.
 */
export const applyCsvImport = async (
  sqlite: BetterSqlite3.Database,
  bytes: Uint8Array,
  options: ApplyOptions,
): Promise<ApplyResult> => {
  const database = createContainerDatabase(sqlite)
  const store = createCsvImportStore(database)
  if (!(await store.available())) {
    throw new Error('The database has not been migrated to the CSV import ledger.')
  }
  const now = options.now ?? (() => new Date())

  const plan = await planCsvImport(database, bytes, {
    sourceId: options.sourceId,
    ...(options.mapping !== undefined ? { mapping: options.mapping } : {}),
    ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
  })
  const refuse = (reason: string): ApplyResult => ({
    status: 'refused',
    reason,
    report: plan.report,
    created: 0,
    alreadyImported: 0,
    rejected: 0,
  })
  if (plan.report.fileErrors.length > 0) return refuse('The file cannot be read.')
  if (plan.report.run.mappingMatches === false) {
    return refuse('This file was started under a different mapping; a retry must use the same one.')
  }
  if (plan.report.rejected.length > 0 && options.skipRejected !== true) {
    return refuse('Some rows are rejected; fix them, or apply the rest with skipRejected.')
  }

  const [owner] = await database.all<{ id: number }>(
    sql`SELECT id FROM users WHERE is_owner = 1 LIMIT 1`,
  )
  if (owner === undefined) return refuse('The database has no owner to act as.')
  const actor = { userId: owner.id, profile: 'administrator' as const }

  const run =
    plan.run ??
    (await store.startRun({
      sourceId: options.sourceId,
      fileSha256: plan.fileSha256,
      mappingJson: plan.mappingJson,
      mappingSha256: plan.mappingSha256,
      totalRows: plan.report.file.dataRows,
      now: now().toISOString(),
    }))

  const resources = createGeneralResourceRepository(database)
  const tracked = new DrizzleTrackedResourceRepository(
    database,
    createTimesheetLockPolicyRepository(database),
  )
  const stamp = () => now().toISOString()

  const ensure = async (target: Entity): Promise<number> => {
    if (target.id !== null) return target.id
    const created =
      target.kind === 'person'
        ? await resources.create(
            'users',
            {
              firstName: target.person!.firstName,
              lastName: target.person!.lastName,
              email: target.email!,
              // Nobody gains access by being imported; an administrator turns a
              // person on deliberately.
              isActive: false,
              profile: 'member',
            },
            stamp(),
            undefined,
          )
        : target.kind === 'client'
          ? await resources.create(
              'clients',
              { name: target.name, currency: target.currency! },
              stamp(),
              undefined,
            )
          : target.kind === 'project'
            ? await resources.create(
                'projects',
                { clientId: await ensure(target.parent!), name: target.name },
                stamp(),
                undefined,
              )
            : await resources.create('tasks', { name: target.name }, stamp(), undefined)
    target.id = Number(created.id)
    return target.id
  }

  let created = 0
  let rejected = 0
  let failure: string | undefined
  let aborted = false
  const applyRejected: RejectedRow[] = []
  for (const item of plan.items) {
    if (options.signal?.aborted === true) {
      aborted = true
      break
    }
    if (item.state === 'rejected') {
      rejected += 1
      continue
    }
    if (item.state === 'existing') continue
    try {
      const userId = await ensure(item.person!)
      const projectId = await ensure(item.project!)
      const taskId = await ensure(item.task!)
      const [userAssignment] = await database.all<{ is_active: number }>(
        sql`SELECT is_active FROM user_assignments WHERE user_id = ${userId} AND project_id = ${projectId}`,
      )
      if (userAssignment === undefined) {
        await resources.create('user-assignments', { userId, projectId }, stamp(), undefined)
      }
      const [taskAssignment] = await database.all<{ is_active: number }>(
        sql`SELECT is_active FROM task_assignments WHERE project_id = ${projectId} AND task_id = ${taskId}`,
      )
      if (taskAssignment === undefined) {
        await resources.create(
          'task-assignments',
          {
            projectId,
            taskId,
            ...(item.row.billable !== null ? { billable: item.row.billable } : {}),
          },
          stamp(),
          undefined,
        )
      }
      const time = boundaryAt(now())
      await tracked.createTimeEntry(
        actor,
        {
          userId,
          projectId,
          taskId,
          spentDate: item.row.date,
          ...(item.row.startedTime !== null
            ? { startedTime: item.row.startedTime, endedTime: item.row.endedTime! }
            : { seconds: item.row.seconds }),
          notes: item.row.notes,
        },
        time,
        [
          store.recordEntry({
            runId: run.id,
            sourceId: options.sourceId,
            sourceKey: item.key,
            now: time.instant,
          }),
        ],
      )
      created += 1
    } catch (error) {
      if (isDuplicateCsvImportKey(error)) continue
      const refusal = domainRejection(error)
      if (refusal === null) {
        failure = error instanceof Error ? error.message : String(error)
        break
      }
      rejected += 1
      applyRejected.push({ line: item.row.line, category: 'unsupported', ...refusal })
    }
  }

  const status: CsvImportRun['status'] =
    failure !== undefined
      ? 'partial'
      : aborted
        ? 'aborted'
        : rejected === 0 || options.skipRejected === true
          ? 'complete'
          : 'partial'
  await store.finishRun(run.id, {
    status,
    rejectedRows: rejected,
    lastError:
      failure ?? (status === 'partial' ? `${rejected} row(s) were refused while applying.` : null),
    now: stamp(),
  })
  plan.report.rejected.push(...applyRejected)
  return {
    status,
    report: plan.report,
    created,
    alreadyImported: plan.report.entries.alreadyImported,
    rejected,
    ...(failure !== undefined ? { error: failure } : {}),
  }
}
