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
import { nameKey, parseCsv, sourceKeys, type CsvIssue, type CsvRow } from './csv-contract.js'
import { canonicalMapping, emptyMapping, parseMapping, type CsvMapping } from './csv-mapping.js'

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

export type EntityKind = 'person' | 'client' | 'project' | 'task'

export interface EntityTally {
  matched: number
  new: number
  rejected: number
}

export interface RejectedRow extends CsvIssue {
  /** `invalid` breaks the contract; `unsupported` is a good row this instance cannot take. */
  category: 'invalid' | 'unsupported'
}

export interface CsvImportReport {
  sourceId: string
  file: { sha256: string; bytes: number; dataRows: number }
  fileErrors: CsvIssue[]
  entries: { total: number; new: number; alreadyImported: number; rejected: number }
  people: EntityTally
  clients: EntityTally
  projects: EntityTally
  tasks: EntityTally
  assignments: { userProject: number; projectTask: number }
  rejected: RejectedRow[]
  warnings: CsvIssue[]
  run: { state: 'none' | CsvImportRun['status']; mappingMatches: boolean | null }
}

interface Entity {
  kind: EntityKind
  key: string
  name: string
  id: number | null
  status: 'matched' | 'new' | 'rejected'
  email?: string
  person?: { firstName: string; lastName: string }
  currency?: string
  parent?: Entity
}

interface PlannedRow {
  row: CsvRow
  key: string
  state: 'existing' | 'rejected' | 'ready'
  person?: Entity
  client?: Entity
  project?: Entity
  task?: Entity
}

interface Plan {
  report: CsvImportReport
  items: PlannedRow[]
  mapping: CsvMapping
  mappingJson: string
  mappingSha256: string
  run: CsvImportRun | null
  fileSha256: string
}

interface NamedRow {
  id: number
  name: string
  is_active: number
}
interface ClientRow extends NamedRow {
  currency: string
}
interface ProjectRow extends NamedRow {
  client_id: number
}
interface TaskRow extends NamedRow {
  billable_by_default: number
}

const reportRejection = (
  rejected: RejectedRow[],
  line: number,
  category: RejectedRow['category'],
  code: string,
  message: string,
): void => {
  rejected.push({ line, category, code, message })
}

const rowsOf = async <T>(database: Database, query: SQL): Promise<T[]> =>
  (await database.all<T>(query)) as T[]

const group = <T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    map.set(key, [...(map.get(key) ?? []), row])
  }
  return map
}

const tallyOf = (entities: Iterable<Entity>, kind: EntityKind): EntityTally => {
  const tally: EntityTally = { matched: 0, new: 0, rejected: 0 }
  for (const entity of entities) if (entity.kind === kind) tally[entity.status] += 1
  return tally
}

const pair = (left: Entity, right: Entity): string => `${left.key}|${right.key}`

/**
 * Read the file against the database and say what applying it would do. Reads
 * only; the one thing it may write is the lock bookkeeping the application
 * itself performs on every read, which `dryRunCsvImport` rolls back.
 */
export const planCsvImport = async (
  database: Database,
  bytes: Uint8Array,
  options: { sourceId: string; mapping?: CsvMapping },
): Promise<Plan> => {
  const parsed = parseCsv(bytes)
  const store = createCsvImportStore(database)
  const stored = (await store.available())
    ? await store.findRun(options.sourceId, parsed.sha256)
    : null
  const mapping =
    options.mapping ?? (stored === null ? emptyMapping() : parseMapping(stored.mappingJson))
  const canonical = canonicalMapping(mapping)

  const report: CsvImportReport = {
    sourceId: options.sourceId,
    file: { sha256: parsed.sha256, bytes: parsed.bytes, dataRows: parsed.dataRows },
    fileErrors: parsed.fileErrors,
    entries: { total: parsed.dataRows, new: 0, alreadyImported: 0, rejected: 0 },
    people: { matched: 0, new: 0, rejected: 0 },
    clients: { matched: 0, new: 0, rejected: 0 },
    projects: { matched: 0, new: 0, rejected: 0 },
    tasks: { matched: 0, new: 0, rejected: 0 },
    assignments: { userProject: 0, projectTask: 0 },
    rejected: [],
    warnings: [...parsed.warnings],
    run: {
      state: stored?.status ?? 'none',
      mappingMatches: stored === null ? null : stored.mappingSha256 === canonical.sha256,
    },
  }
  const plan: Plan = {
    report,
    items: [],
    mapping,
    mappingJson: canonical.json,
    mappingSha256: canonical.sha256,
    run: stored,
    fileSha256: parsed.sha256,
  }
  if (parsed.fileErrors.length > 0) return plan

  for (const issue of parsed.invalid) {
    reportRejection(report.rejected, issue.line, 'invalid', issue.code, issue.message)
  }

  const [organization] = await rowsOf<{ time_entry_mode: string; currency: string }>(
    database,
    sql`SELECT time_entry_mode, currency FROM organizations WHERE id = 1`,
  )
  if (organization === undefined)
    throw new Error('The database has no organization to import into.')
  const [emails, clients, projects, tasks, userAssignments, taskAssignments, submissions] =
    await Promise.all([
      rowsOf<{ email: string; user_id: number }>(
        database,
        sql`SELECT lower(address) AS email, user_id FROM user_emails
          WHERE verified_at IS NOT NULL AND invalidated_at IS NULL`,
      ),
      rowsOf<ClientRow>(database, sql`SELECT id, name, is_active, currency FROM clients`),
      rowsOf<ProjectRow>(database, sql`SELECT id, client_id, name, is_active FROM projects`),
      rowsOf<TaskRow>(database, sql`SELECT id, name, is_active, billable_by_default FROM tasks`),
      rowsOf<{ user_id: number; project_id: number; is_active: number }>(
        database,
        sql`SELECT user_id, project_id, is_active FROM user_assignments`,
      ),
      rowsOf<{ project_id: number; task_id: number; billable: number; is_active: number }>(
        database,
        sql`SELECT project_id, task_id, billable, is_active FROM task_assignments`,
      ),
      rowsOf<{ user_id: number; period_start: string; period_end: string; status: string }>(
        database,
        sql`SELECT user_id, period_start, period_end, status FROM timesheet_submissions
          WHERE status IN ('submitted', 'approved')`,
      ),
    ])
  const userByEmail = new Map(emails.map((row) => [row.email, row.user_id]))
  const clientsByName = group(clients, (row) => nameKey(row.name))
  const projectsByName = group(projects, (row) => `${row.client_id}|${nameKey(row.name)}`)
  const tasksByName = group(tasks, (row) => nameKey(row.name))
  const userAssigned = new Map(
    userAssignments.map((row) => [`${row.user_id}|${row.project_id}`, row]),
  )
  const taskAssigned = new Map(
    taskAssignments.map((row) => [`${row.project_id}|${row.task_id}`, row]),
  )

  const imported = (await store.available())
    ? await store.importedKeys(options.sourceId)
    : new Set<string>()

  const entities = new Map<string, Entity>()
  const entity = (candidate: Entity): Entity => {
    const known = entities.get(candidate.key)
    if (known !== undefined) return known
    entities.set(candidate.key, candidate)
    return candidate
  }
  const fromRows = <T extends NamedRow>(
    kind: EntityKind,
    matches: readonly T[] | undefined,
    label: string,
  ): { entity: Entity; code?: string } | null => {
    if (matches === undefined || matches.length === 0) return null
    if (matches.length > 1) {
      return {
        entity: entity({
          kind,
          key: `ambiguous:${kind}:${label}`,
          name: label,
          id: null,
          status: 'rejected',
        }),
        code: `${kind}_ambiguous`,
      }
    }
    const match = matches[0]!
    if (match.is_active !== 1) {
      return {
        entity: entity({
          kind,
          key: `archived:${kind}:${match.id}`,
          name: match.name,
          id: match.id,
          status: 'rejected',
        }),
        code: `${kind}_archived`,
      }
    }
    return {
      entity: entity({
        kind,
        key: `#${kind}:${match.id}`,
        name: match.name,
        id: match.id,
        status: 'matched',
      }),
    }
  }

  const keys = sourceKeys(parsed.rows)
  const candidates: PlannedRow[] = []
  parsed.rows.forEach((row, index) => {
    const key = keys[index]!
    candidates.push({ row, key, state: imported.has(key) ? 'existing' : 'ready' })
  })

  const reject = (item: PlannedRow, code: string, message: string): void => {
    item.state = 'rejected'
    reportRejection(report.rejected, item.row.line, 'unsupported', code, message)
  }

  for (const item of candidates) {
    if (item.state === 'existing') continue
    const { row } = item

    const mappedPerson = Object.hasOwn(mapping.people, row.personEmail)
      ? mapping.people[row.personEmail]!
      : row.personEmail
    if (typeof mappedPerson === 'object') {
      const userId = userByEmail.get(row.personEmail)
      item.person =
        userId !== undefined
          ? entity({
              kind: 'person',
              key: `#person:${userId}`,
              name: row.personEmail,
              id: userId,
              status: 'matched',
            })
          : entity({
              kind: 'person',
              key: `new:person:${row.personEmail}`,
              name: row.personEmail,
              id: null,
              status: 'new',
              email: row.personEmail,
              person: mappedPerson.create,
            })
    } else {
      const userId = userByEmail.get(mappedPerson)
      if (userId === undefined) {
        item.person = entity({
          kind: 'person',
          key: `missing:person:${mappedPerson}`,
          name: mappedPerson,
          id: null,
          status: 'rejected',
        })
        reject(
          item,
          mappedPerson === row.personEmail ? 'person_unmapped' : 'person_not_found',
          mappedPerson === row.personEmail
            ? `${row.personEmail} is not a person here; map it to one or to { "create": ... }.`
            : `${row.personEmail} is mapped to ${mappedPerson}, who is not a person here.`,
        )
      } else {
        item.person = entity({
          kind: 'person',
          key: `#person:${userId}`,
          name: mappedPerson,
          id: userId,
          status: 'matched',
        })
      }
    }

    const clientName = Object.hasOwn(mapping.clients, nameKey(row.client))
      ? mapping.clients[nameKey(row.client)]!
      : row.client
    const clientLabel = nameKey(clientName)
    const foundClient = fromRows('client', clientsByName.get(clientLabel), clientLabel)
    if (foundClient === null) {
      item.client = entity({
        kind: 'client',
        key: `new:client:${clientLabel}`,
        name: clientName.trim().replace(/\s+/g, ' '),
        id: null,
        status: 'new',
        currency: row.currency ?? organization.currency,
      })
    } else {
      item.client = foundClient.entity
      if (foundClient.code !== undefined) {
        reject(
          item,
          foundClient.code,
          `Client ${JSON.stringify(clientName)} cannot take time: ${foundClient.code}.`,
        )
      }
    }
    const clientCurrency =
      item.client.status === 'new'
        ? item.client.currency
        : clients.find((candidate) => candidate.id === item.client!.id)?.currency
    if (row.currency !== null && clientCurrency !== undefined && row.currency !== clientCurrency) {
      report.warnings.push({
        line: row.line,
        code: 'currency_differs',
        message: `currency ${row.currency} differs from the client's ${clientCurrency}; currency is not applied.`,
      })
    }

    if (item.client.status !== 'rejected') {
      const mappedProject = mapping.projects[nameKey(row.client)]
      const projectName =
        mappedProject !== undefined && Object.hasOwn(mappedProject, nameKey(row.project))
          ? mappedProject[nameKey(row.project)]!
          : row.project
      const projectLabel = nameKey(projectName)
      const foundProject =
        item.client.id === null
          ? null
          : fromRows(
              'project',
              projectsByName.get(`${item.client.id}|${projectLabel}`),
              projectLabel,
            )
      if (foundProject === null) {
        item.project = entity({
          kind: 'project',
          key: `new:project:${item.client.key}/${projectLabel}`,
          name: projectName.trim().replace(/\s+/g, ' '),
          id: null,
          status: 'new',
          parent: item.client,
        })
      } else {
        item.project = foundProject.entity
        if (foundProject.code !== undefined) {
          reject(
            item,
            foundProject.code,
            `Project ${JSON.stringify(projectName)} cannot take time: ${foundProject.code}.`,
          )
        }
      }
    }

    const taskName = Object.hasOwn(mapping.tasks, nameKey(row.task))
      ? mapping.tasks[nameKey(row.task)]!
      : row.task
    const taskLabel = nameKey(taskName)
    const foundTask = fromRows('task', tasksByName.get(taskLabel), taskLabel)
    if (foundTask === null) {
      item.task = entity({
        kind: 'task',
        key: `new:task:${taskLabel}`,
        name: taskName.trim().replace(/\s+/g, ' '),
        id: null,
        status: 'new',
      })
    } else {
      item.task = foundTask.entity
      if (foundTask.code !== undefined) {
        reject(
          item,
          foundTask.code,
          `Task ${JSON.stringify(taskName)} cannot take time: ${foundTask.code}.`,
        )
      }
    }

    if (row.startedTime === null && organization.time_entry_mode === 'start_end') {
      reject(
        item,
        'hours_not_accepted',
        'This organization records start and end times; the row gives hours only.',
      )
    }
  }

  // Locks and timesheet periods, for the rows still standing. The policy
  // resolves weekly deadlines on the application's own clock.
  const standing = candidates.filter((item) => item.state === 'ready')
  const dates = [...new Set(standing.map((item) => item.row.date))]
  const policy = createTimesheetLockPolicyRepository(database)
  const locked = dates.length > 0 ? await policy.lockedDates(dates) : new Map<string, boolean>()
  for (const item of standing) {
    if (locked.get(item.row.date) === true) {
      reject(item, 'period_locked', `${item.row.date} is inside a locked timesheet period.`)
      continue
    }
    const userId = item.person?.id
    if (userId === null || userId === undefined) continue
    const period = submissions.find(
      (candidate) =>
        candidate.user_id === userId &&
        candidate.period_start <= item.row.date &&
        item.row.date <= candidate.period_end,
    )
    if (period !== undefined) {
      reject(
        item,
        period.status === 'approved' ? 'period_approved' : 'period_submitted',
        `${item.row.date} is inside a ${period.status} timesheet for this person.`,
      )
    }
  }

  // Assignments, in file order for the rows that will be written.
  const plannedUser = new Set<string>()
  const plannedTask = new Map<string, boolean>()
  for (const item of candidates) {
    if (item.state !== 'ready') continue
    const { person, project, task, row } = item
    if (person === undefined || project === undefined || task === undefined) continue
    if (person.id !== null && project.id !== null) {
      const existing = userAssigned.get(`${person.id}|${project.id}`)
      if (existing !== undefined && existing.is_active !== 1) {
        reject(item, 'assignment_archived', "The person's assignment to this project is archived.")
        continue
      }
    }
    if (project.id !== null && task.id !== null) {
      const existing = taskAssigned.get(`${project.id}|${task.id}`)
      if (existing !== undefined && existing.is_active !== 1) {
        reject(item, 'assignment_archived', "The task's assignment to this project is archived.")
        continue
      }
      if (
        existing !== undefined &&
        row.billable !== null &&
        (existing.billable === 1) !== row.billable
      ) {
        report.warnings.push({
          line: row.line,
          code: 'billable_not_applied',
          message:
            'billable differs from the task assignment, which decides it; the entry follows the assignment.',
        })
      }
    }
    const userKey = pair(person, project)
    const userExists =
      person.id !== null && project.id !== null && userAssigned.has(`${person.id}|${project.id}`)
    if (!userExists) plannedUser.add(userKey)
    const taskKey = pair(project, task)
    const taskExists =
      project.id !== null && task.id !== null && taskAssigned.has(`${project.id}|${task.id}`)
    if (!taskExists) {
      const first = plannedTask.get(taskKey)
      if (first === undefined) plannedTask.set(taskKey, row.billable ?? true)
      else if (row.billable !== null && row.billable !== first) {
        report.warnings.push({
          line: row.line,
          code: 'billable_not_applied',
          message:
            'billable differs from the first row for this project and task, which decides it.',
        })
      }
    }
  }

  plan.items = candidates
  const rejectedLines = new Set(report.rejected.map((issue) => issue.line))
  report.entries.alreadyImported = candidates.filter((item) => item.state === 'existing').length
  report.entries.new = candidates.filter((item) => item.state === 'ready').length
  report.entries.rejected = rejectedLines.size
  const counted = new Set<Entity>()
  for (const item of candidates) {
    if (item.state === 'existing') continue
    for (const touched of [item.person, item.client, item.project, item.task]) {
      if (touched !== undefined) counted.add(touched)
    }
  }
  report.people = tallyOf(counted, 'person')
  report.clients = tallyOf(counted, 'client')
  report.projects = tallyOf(counted, 'project')
  report.tasks = tallyOf(counted, 'task')
  report.assignments = { userProject: plannedUser.size, projectTask: plannedTask.size }
  report.rejected.sort((left, right) => left.line - right.line)
  report.warnings.sort((left, right) => left.line - right.line)
  return plan
}

/**
 * The dry run: the plan, inside a transaction that is always rolled back, so
 * that nothing the planning read path might record survives it.
 */
export const dryRunCsvImport = async (
  sqlite: BetterSqlite3.Database,
  bytes: Uint8Array,
  options: { sourceId: string; mapping?: CsvMapping },
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
