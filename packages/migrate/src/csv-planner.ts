import { CsvBrowserPlannerError, assertCsvExporterZone } from './csv-browser-errors.js'
import {
  assertBrowserMappingSources,
  csvSourceEntityKeys,
  type CsvBrowserMapping,
  type CsvBrowserDestinationIds,
} from './csv-browser-mapping.js'
import {
  roundTimeSeconds,
  effectiveTimeRounding,
  resolveTimeEntryNoteRequirement,
  timeEntryNoteLength,
  type TimeRoundingMode,
  type TimeRoundingMinutes,
  type CsvImportDestinationScope,
  type CsvPlanInput,
} from '@ezacto/core'
import { CLOCKIFY_ADAPTERS } from './csv-clockify.js'
import { sha256Hex } from './portable-hash.js'
import { nameKey, sourceKeys, type ParsedCsv, type CsvIssue, type CsvRow } from './csv-contract.js'
import { canonicalMapping, emptyMapping, parseMapping, type CsvMapping } from './csv-mapping.js'

export interface CsvPlanningRun {
  id: number
  status: 'partial' | 'aborted' | 'complete'
  mappingJson: string
  mappingSha256: string
}
export interface CsvDestinationSnapshot {
  organization: { time_entry_mode: string; currency: string }
  stored: CsvPlanningRun | null
  emails: { email: string; user_id: number }[]
  clients: ClientRow[]
  projects: ProjectRow[]
  tasks: TaskRow[]
  userAssignments: { user_id: number; project_id: number; is_active: number }[]
  taskAssignments: { project_id: number; task_id: number; billable: number; is_active: number }[]
  submissions: { user_id: number; period_start: string; period_end: string; status: string }[]
  knownUserIds?: readonly number[]
  importedKeys: string[]
  lockedDates: string[]
}

export interface CsvBrowserDestinationSnapshot extends CsvDestinationSnapshot {
  actor: { kind: 'administrator'; userId: string }
  destinationVersion: string
  destinationFacts: string
  fileSha256: string
  mappingSha256: string
  sourceId: string
  excludedLines: readonly number[]
  importedEntries: { sourceKey: string; roundedSeconds: number | null }[]
  futureProjectUserIds: number[]
  defaultTaskIds: number[]
  users: {
    id: number
    is_active: number
    profile: string
    time_entry_notes_minimum_length: number | null
  }[]
  organizationPolicy: {
    time_rounding_mode: TimeRoundingMode
    time_rounding_minutes: TimeRoundingMinutes
    time_entry_notes_required: number
    time_entry_notes_minimum_length: number
  }
  projectPolicy: {
    id: number
    time_rounding_mode: TimeRoundingMode | null
    time_rounding_minutes: TimeRoundingMinutes | null
    time_entry_notes_minimum_length: number | null
  }[]
  assignmentPolicy: {
    user_id: number
    project_id: number
    time_entry_notes_minimum_length: number | null
  }[]
}

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
  run: { state: 'none' | CsvPlanningRun['status']; mappingMatches: boolean | null }
}

export interface Entity {
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

export interface PlannedRow {
  row: CsvRow
  key: string
  state: 'existing' | 'rejected' | 'ready'
  person?: Entity
  client?: Entity
  project?: Entity
  task?: Entity
}

export interface Plan {
  report: CsvImportReport
  items: PlannedRow[]
  mapping: CsvMapping
  mappingJson: string
  mappingSha256: string
  run: CsvPlanningRun | null
  fileSha256: string
  policyDates: string[]
}

export interface NamedRow {
  id: number
  name: string
  is_active: number
}
export interface ClientRow extends NamedRow {
  currency: string
}
export interface ProjectRow extends NamedRow {
  client_id: number
}
export interface TaskRow extends NamedRow {
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

const pair = (left: Entity, right: Entity): string => JSON.stringify([left.key, right.key])

export const resolveCsvPlan = (
  parsed: ParsedCsv,
  snapshot: CsvDestinationSnapshot,
  options: {
    sourceId: string
    mapping?: CsvMapping
    sourceKeys?: readonly string[]
    destinationIds?: CsvBrowserDestinationIds
  },
): Plan => {
  const {
    stored,
    organization,
    emails,
    clients,
    projects,
    tasks,
    userAssignments,
    taskAssignments,
    submissions,
  } = snapshot
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
    policyDates: [],
  }
  if (parsed.fileErrors.length > 0) return plan

  for (const issue of parsed.invalid) {
    reportRejection(report.rejected, issue.line, 'invalid', issue.code, issue.message)
  }

  const userByEmail = new Map(emails.map((row) => [row.email, row.user_id]))
  const clientsByName = group(clients, (row) => nameKey(row.name))
  const projectsByName = group(projects, (row) =>
    JSON.stringify([row.client_id, nameKey(row.name)]),
  )
  const tasksByName = group(tasks, (row) => nameKey(row.name))
  const userAssigned = new Map(
    userAssignments.map((row) => [`${row.user_id}|${row.project_id}`, row]),
  )
  const taskAssigned = new Map(
    taskAssignments.map((row) => [`${row.project_id}|${row.task_id}`, row]),
  )

  const imported = new Set(snapshot.importedKeys)

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
    identityLabel = label,
  ): { entity: Entity; code?: string } | null => {
    if (matches === undefined || matches.length === 0) return null
    if (matches.length > 1) {
      return {
        entity: entity({
          kind,
          key: JSON.stringify(['ambiguous', kind, identityLabel]),
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

  const explicitTarget = <T extends NamedRow>(
    kind: EntityKind,
    id: number,
    rows: readonly T[],
    label: string,
  ) =>
    fromRows(
      kind,
      rows.filter((row) => row.id === id),
      label,
    ) ?? {
      entity: entity({
        kind,
        key: JSON.stringify(['missing-id', kind, id]),
        name: label,
        id: null,
        status: 'rejected',
      }),
      code: `${kind}_not_found`,
    }

  const keys = options.sourceKeys ?? sourceKeys(parsed.rows)
  if (keys.length !== parsed.rows.length)
    throw new CsvBrowserPlannerError('source_identity_mismatch')
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
    const explicit = csvSourceEntityKeys(row)

    const chosenPerson = options.destinationIds?.people[explicit.people]
    if (chosenPerson !== undefined) {
      if (snapshot.knownUserIds?.includes(chosenPerson))
        item.person = entity({
          kind: 'person',
          key: `#person:${chosenPerson}`,
          name: row.personEmail,
          id: chosenPerson,
          status: 'matched',
        })
      else {
        item.person = entity({
          kind: 'person',
          key: JSON.stringify(['missing-person-id', chosenPerson]),
          name: row.personEmail,
          id: null,
          status: 'rejected',
        })
        reject(item, 'person_not_found', 'The selected person does not exist.')
      }
    } else {
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
    }
    const clientName = Object.hasOwn(mapping.clients, nameKey(row.client))
      ? mapping.clients[nameKey(row.client)]!
      : row.client
    const clientLabel = nameKey(clientName)
    const chosenClient = options.destinationIds?.clients[explicit.clients]
    const foundClient =
      chosenClient === undefined
        ? fromRows('client', clientsByName.get(clientLabel), clientLabel)
        : explicitTarget('client', chosenClient, clients, clientLabel)
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
      const chosenProject = options.destinationIds?.projects[explicit.projects]
      const foundProject =
        chosenProject !== undefined
          ? explicitTarget(
              'project',
              chosenProject,
              projects.filter((candidate) => candidate.client_id === item.client!.id),
              projectLabel,
            )
          : item.client.id === null
            ? null
            : fromRows(
                'project',
                projectsByName.get(JSON.stringify([item.client.id, projectLabel])),
                projectLabel,
                JSON.stringify([item.client.key, projectLabel]),
              )
      if (foundProject === null) {
        item.project = entity({
          kind: 'project',
          key: JSON.stringify(['new:project', item.client.key, projectLabel]),
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
    const chosenTask = options.destinationIds?.tasks[explicit.tasks]
    const foundTask =
      chosenTask === undefined
        ? fromRows('task', tasksByName.get(taskLabel), taskLabel)
        : explicitTarget('task', chosenTask, tasks, taskLabel)
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
  plan.policyDates = [...new Set(standing.map((item) => item.row.date))]
  const locked = new Map(snapshot.lockedDates.map((date) => [date, true]))
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

/** Scope resolution names with the same normalizer used by the actual resolver. */
export const csvBrowserDestinationScope = (
  parsed: ParsedCsv,
  mapping: CsvBrowserMapping,
  snapshot: CsvDestinationSnapshot,
  originalSourceKeys?: readonly string[],
): CsvImportDestinationScope => {
  const emailHashes = new Set<string>(),
    clientHashes = new Set<string>(),
    taskHashes = new Set<string>()
  const selectedIds = {
    people: new Set<number>(),
    clients: new Set<number>(),
    projects: new Set<number>(),
    tasks: new Set<number>(),
  }
  const pairs = new Map<string, { client: string; project: string; clientId?: number }>()
  for (const row of parsed.rows) {
    const keys = csvSourceEntityKeys(row),
      ids = mapping.destinationIds
    for (const section of ['people', 'clients', 'projects', 'tasks'] as const) {
      const chosen = ids?.[section][keys[section]]
      if (chosen !== undefined) selectedIds[section].add(chosen)
    }
    if (ids?.people[keys.people] === undefined) {
      const person = mapping.people[row.personEmail]
      emailHashes.add(sha256Hex(typeof person === 'string' ? person : row.personEmail))
    }
    const client = sha256Hex(nameKey(mapping.clients[nameKey(row.client)] ?? row.client))
    const project = sha256Hex(
      nameKey(mapping.projects[nameKey(row.client)]?.[nameKey(row.project)] ?? row.project),
    )
    const clientId = ids?.clients[keys.clients]
    if (clientId === undefined) clientHashes.add(client)
    if (ids?.projects[keys.projects] === undefined) {
      const pair = { client, project, ...(clientId === undefined ? {} : { clientId }) }
      pairs.set(JSON.stringify(pair), pair)
    }
    if (ids?.tasks[keys.tasks] === undefined)
      taskHashes.add(sha256Hex(nameKey(mapping.tasks[nameKey(row.task)] ?? row.task)))
  }
  const provisional = resolveCsvPlan(parsed, snapshot, {
    sourceId: 'preview',
    mapping,
    sourceKeys: originalSourceKeys,
    destinationIds: mapping.destinationIds,
  })
  const targetIds = (
    kind: 'person' | 'client' | 'project' | 'task',
    section: keyof CsvBrowserDestinationIds,
  ) =>
    [
      ...new Set([
        ...selectedIds[section],
        ...provisional.items.flatMap((item) => (item[kind]?.id == null ? [] : [item[kind]!.id!])),
      ]),
    ].sort((a, b) => a - b)
  return {
    emailHashes: [...emailHashes].sort(),
    clientHashes: [...clientHashes].sort(),
    taskHashes: [...taskHashes].sort(),
    projectPairs: [...pairs.values()].sort((a, b) =>
      `${a.client}:${a.project}`.localeCompare(`${b.client}:${b.project}`),
    ),
    dates: [...new Set(parsed.rows.map((row) => row.date))].sort(),
    personIds: targetIds('person', 'people'),
    clientIds: targetIds('client', 'clients'),
    projectIds: targetIds('project', 'projects'),
    taskIds: targetIds('task', 'tasks'),
    includeProjectDefaults: provisional.items.some(
      (item) => item.state === 'ready' && item.project?.status === 'new',
    ),
  }
}

export interface CsvBrowserPlanOptions {
  sourceId: string
  actor: { kind: 'administrator'; userId: string }
  excludedLines?: readonly number[]
  adapterId: string
  exporterZone: string
}
export interface CsvBrowserPlan {
  actor: { kind: 'administrator'; userId: string }
  adapterId: string
  exporterZone: string
  destinationVersion: string
  destinationFacts: string
  deletedImportedRows: number
  selectionHash: string
  excludedLines: readonly number[]
  sourceSeconds: number
  destinationSeconds: number
  destinationDeltaSeconds: number
  selectedRows: number
  fileRows: number
  rejectedRows: number
  diagnosticCount: number
  organizationCurrency: string
  unpriced: true
  plan: Plan
}
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Pure browser planning over an immutable destination read, never a writer or rollback preview. */
export const planCsvImportFromSnapshot = (
  parsed: ParsedCsv,
  mapping: CsvBrowserMapping,
  snapshot: CsvBrowserDestinationSnapshot,
  options: CsvBrowserPlanOptions,
): CsvBrowserPlan => {
  assertBrowserMappingSources(mapping, parsed.rows)
  if (options.adapterId !== CLOCKIFY_ADAPTERS.browser)
    throw new CsvBrowserPlannerError('adapter_unsupported')
  assertCsvExporterZone(options.exporterZone)
  if (options.actor.kind !== 'administrator' || options.actor.userId !== snapshot.actor.userId)
    throw new CsvBrowserPlannerError('administrator_required')
  const actor = snapshot.users.find((user) => String(user.id) === options.actor.userId)
  if (!actor || actor.is_active !== 1 || actor.profile !== 'administrator')
    throw new CsvBrowserPlannerError('administrator_required')
  if (
    snapshot.fileSha256 !== parsed.sha256 ||
    snapshot.mappingSha256 !== canonicalMapping(mapping).sha256 ||
    snapshot.sourceId !== options.sourceId
  )
    throw new CsvBrowserPlannerError('snapshot_input_mismatch')
  const excludedLines = [...new Set(options.excludedLines ?? [])].sort((a, b) => a - b)
  if (JSON.stringify(excludedLines) !== JSON.stringify(snapshot.excludedLines))
    throw new CsvBrowserPlannerError('snapshot_selection_mismatch')
  const sourceLines = new Set([
    ...parsed.rows.map((row) => row.line),
    ...parsed.invalid.map((issue) => issue.line),
  ])
  if (
    excludedLines.some((line) => !Number.isSafeInteger(line) || !sourceLines.has(line)) ||
    (parsed.fileErrors.length > 0 && excludedLines.length > 0)
  )
    throw new CsvBrowserPlannerError('invalid_exclusion')
  const excluded = new Set(excludedLines)
  const keys = sourceKeys(parsed.rows)
  const originalKeys = new Map(parsed.rows.map((row, index) => [row.line, keys[index]!]))
  const selected = {
    ...parsed,
    rows: parsed.rows.filter((row) => !excluded.has(row.line)),
    invalid: parsed.invalid.filter((issue) => !excluded.has(issue.line)),
  }
  // Copy caller-owned objects: a confirmation cannot be changed by later UI mutation.
  const plan = resolveCsvPlan(structuredClone(selected), structuredClone(snapshot), {
    sourceId: options.sourceId,
    mapping: structuredClone(mapping),
    destinationIds: mapping.destinationIds,
    sourceKeys: selected.rows.map((row) => originalKeys.get(row.line)!),
  })
  const userById = new Map(snapshot.users.map((row) => [row.id, row]))
  const projectById = new Map(snapshot.projectPolicy.map((row) => [row.id, row]))
  const pairByIds = new Map(
    snapshot.assignmentPolicy.map((row) => [`${row.user_id}:${row.project_id}`, row]),
  )
  const importedByKey = new Map(snapshot.importedEntries.map((row) => [row.sourceKey, row]))
  let sourceSeconds = 0,
    destinationSeconds = 0,
    deletedImportedRows = 0
  for (const item of plan.items) {
    item.key = originalKeys.get(item.row.line)!
    if (item.state === 'rejected') continue
    if (item.state === 'existing') {
      sourceSeconds += item.row.seconds
      const prior = importedByKey.get(item.key)
      if (prior?.roundedSeconds == null) deletedImportedRows += 1
      else destinationSeconds += prior.roundedSeconds
      continue
    }
    const user = userById.get(item.person?.id ?? -1)
    const project = projectById.get(item.project?.id ?? -1)
    const pair = pairByIds.get(`${item.person?.id}:${item.project?.id}`)
    const notes = resolveTimeEntryNoteRequirement({
      organization: {
        required: snapshot.organizationPolicy.time_entry_notes_required === 1,
        minimumLength: snapshot.organizationPolicy.time_entry_notes_minimum_length,
      },
      personMinimumLength: user?.time_entry_notes_minimum_length ?? null,
      projectMinimumLength: project?.time_entry_notes_minimum_length ?? null,
      pairMinimumLength: pair?.time_entry_notes_minimum_length ?? null,
    })
    if (notes !== null && timeEntryNoteLength(item.row.notes) < notes.minimumLength) {
      item.state = 'rejected'
      plan.report.rejected.push({
        line: item.row.line,
        category: 'unsupported',
        code: 'notes_required',
        message: 'The destination requires a longer time entry note.',
      })
      continue
    }
    const rounding = effectiveTimeRounding(
      {
        mode: snapshot.organizationPolicy.time_rounding_mode,
        minutes: snapshot.organizationPolicy.time_rounding_minutes,
      },
      project?.time_rounding_mode == null
        ? null
        : { mode: project.time_rounding_mode, minutes: project.time_rounding_minutes! },
    )
    sourceSeconds += item.row.seconds
    destinationSeconds += roundTimeSeconds(item.row.seconds, rounding)
  }
  const counted = new Set<Entity>(),
    userSetup = new Set<string>(),
    taskSetup = new Set<string>()
  const userPairs = new Set(
    snapshot.userAssignments.map((row) => `${row.user_id}:${row.project_id}`),
  )
  const taskPairs = new Set(
    snapshot.taskAssignments.map((row) => `${row.project_id}:${row.task_id}`),
  )
  const defaults = new Map(snapshot.tasks.map((row) => [row.id, row.billable_by_default]))
  for (const item of plan.items) {
    if (item.state === 'existing') continue
    for (const entity of [item.person, item.client, item.project, item.task])
      if (entity && (item.state === 'ready' || entity.status === 'rejected')) counted.add(entity)
    if (item.state !== 'ready' || !item.person || !item.project || !item.task) continue
    const implicitPerson =
      item.project.id === null &&
      item.person.id !== null &&
      snapshot.futureProjectUserIds.includes(item.person.id)
    const implicitTask =
      item.project.id === null &&
      item.task.id !== null &&
      snapshot.defaultTaskIds.includes(item.task.id)
    if (!implicitPerson && !userPairs.has(`${item.person.id}:${item.project.id}`))
      userSetup.add(pair(item.person, item.project))
    if (!implicitTask && !taskPairs.has(`${item.project.id}:${item.task.id}`))
      taskSetup.add(pair(item.project, item.task))
    if (
      implicitTask &&
      item.row.billable !== null &&
      (defaults.get(item.task.id!) === 1) !== item.row.billable
    ) {
      plan.report.warnings.push({
        line: item.row.line,
        code: 'billable_not_applied',
        message: 'The project default task assignment decides billable status.',
      })
    }
  }
  plan.report.people = tallyOf(counted, 'person')
  plan.report.clients = tallyOf(counted, 'client')
  plan.report.projects = tallyOf(counted, 'project')
  plan.report.tasks = tallyOf(counted, 'task')
  plan.report.assignments = { userProject: userSetup.size, projectTask: taskSetup.size }
  const rejectedRows = new Set(plan.report.rejected.map((issue) => issue.line)).size
  plan.report.entries.new = plan.items.filter((item) => item.state === 'ready').length
  plan.report.entries.rejected = rejectedRows
  plan.report.rejected.sort((a, b) => a.line - b.line)
  return freeze({
    actor: { ...options.actor },
    adapterId: options.adapterId,
    exporterZone: options.exporterZone,
    destinationVersion: snapshot.destinationVersion,
    destinationFacts: snapshot.destinationFacts,
    deletedImportedRows,
    selectionHash: sha256Hex(JSON.stringify(excludedLines)),
    excludedLines,
    sourceSeconds,
    destinationSeconds,
    destinationDeltaSeconds: destinationSeconds - sourceSeconds,
    selectedRows: plan.items.filter((item) => item.state !== 'rejected').length,
    fileRows: parsed.dataRows,
    rejectedRows,
    diagnosticCount: plan.report.rejected.length,
    organizationCurrency: snapshot.organization.currency,
    unpriced: true,
    plan,
  })
}

/** Internal native seal input. Never serialize destinationFacts into a browser DTO. */
export const csvBrowserSealInput = (plan: CsvBrowserPlan): CsvPlanInput => ({
  datasetId: plan.plan.report.sourceId,
  fileRows: plan.fileRows,
  selectedRows: plan.selectedRows,
  fileSha256: plan.plan.fileSha256,
  mappingSha256: plan.plan.mappingSha256,
  adapterId: plan.adapterId,
  identityVersion: 2,
  dateFormat: 'iso',
  exporterZone: plan.exporterZone,
  excludedLines: plan.excludedLines,
  destinationVersion: plan.destinationVersion,
  destinationFacts: plan.destinationFacts,
})
