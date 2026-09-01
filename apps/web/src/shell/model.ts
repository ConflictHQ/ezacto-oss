import {
  EzactoClient,
  EzactoApiError,
  type AuthPrincipal,
  type Expense,
  type GeneralResource,
  type Invoice,
  type InvoiceGenerationInput,
  type InvoiceMessage,
  type InvoicePayment,
  type PasswordSignInInput,
  type Session,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryOption,
  type TimeEntryPatch,
  type TimesheetRejectionInput,
  type TimesheetLockPolicy,
  type TimesheetLockPolicyPatch,
  type TimesheetLockWindow,
  type TimesheetManualLockInput,
  type TimesheetSubmission,
  type TimesheetSubmissionDetail,
  type TimesheetSubmissionInput,
  type TimesheetUnlockInput,
  type TimesheetWithdrawalInput,
  type Whoami,
} from '@ezacto/client'
import type { TimeEntrySettings } from '../components/time-entry-editor.js'
import type { ClientDirectoryApi } from '../clients/model.js'
import type { ProjectDirectoryApi } from '../projects/model.js'
import type { ReportWorkspaceApi } from '../reports/model.js'

interface CursorPage<T> {
  readonly data: readonly T[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ShellApi
  extends Partial<ClientDirectoryApi>,
    Partial<ProjectDirectoryApi>,
    Partial<ReportWorkspaceApi> {
  whoami(signal?: AbortSignal): Promise<Whoami>
  signIn(credentials: PasswordSignInInput, signal?: AbortSignal): Promise<AuthPrincipal>
  logoutCurrentSession(signal?: AbortSignal): Promise<Session>
  listProjects(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  listClients?(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  listInvoices?(cursor?: string, signal?: AbortSignal): Promise<CursorPage<Invoice>>
  getInvoice?(id: number, signal?: AbortSignal): Promise<Invoice>
  listInvoiceMessages?(id: number, signal?: AbortSignal): Promise<readonly InvoiceMessage[]>
  listInvoicePayments?(id: number, signal?: AbortSignal): Promise<readonly InvoicePayment[]>
  listTasks(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  listTimeEntryOptions(signal?: AbortSignal): Promise<readonly TimeEntryOption[]>
  getTimeEntrySettings(signal?: AbortSignal): Promise<TimeEntrySettings>
  listTimeEntries(query: {
    readonly from?: string
    readonly to?: string
    readonly is_running?: boolean
  }, signal?: AbortSignal): Promise<readonly TimeEntry[]>
  listExpenses?(query: {
    readonly from?: string
    readonly to?: string
  }, signal?: AbortSignal): Promise<readonly Expense[]>
  createTimeEntry(input: TimeEntryInput, signal?: AbortSignal): Promise<TimeEntry>
  updateTimeEntry(id: number, patch: TimeEntryPatch, signal?: AbortSignal): Promise<TimeEntry>
  deleteTimeEntry(id: number, signal?: AbortSignal): Promise<void>
  stopTimeEntry(id: number, signal?: AbortSignal): Promise<TimeEntry>
  listTimesheetSubmissions?(
    periodStart: string,
    periodEnd: string,
    signal?: AbortSignal,
  ): Promise<readonly TimesheetSubmission[]>
  submitTimesheet?(
    input: TimesheetSubmissionInput,
    signal?: AbortSignal,
  ): Promise<TimesheetSubmission>
  listPendingTimesheetSubmissions?(signal?: AbortSignal): Promise<readonly TimesheetSubmission[]>
  listApprovedTimesheetSubmissions?(
    periodStart: string,
    signal?: AbortSignal,
  ): Promise<readonly TimesheetSubmission[]>
  getTimesheetSubmission?(id: number, signal?: AbortSignal): Promise<TimesheetSubmissionDetail>
  approveTimesheetSubmission?(id: number, signal?: AbortSignal): Promise<TimesheetSubmission>
  rejectTimesheetSubmission?(
    id: number,
    input: TimesheetRejectionInput,
    signal?: AbortSignal,
  ): Promise<TimesheetSubmission>
  withdrawTimesheetSubmission?(
    id: number,
    input: TimesheetWithdrawalInput,
    signal?: AbortSignal,
  ): Promise<TimesheetSubmission>
  getTimesheetLockPolicy?(signal?: AbortSignal): Promise<TimesheetLockPolicy>
  updateTimesheetLockPolicy?(
    input: TimesheetLockPolicyPatch,
    signal?: AbortSignal,
  ): Promise<TimesheetLockPolicy>
  listTimesheetLocks?(signal?: AbortSignal): Promise<readonly TimesheetLockWindow[]>
  createTimesheetManualLock?(
    commandId: string,
    input: TimesheetManualLockInput,
    signal?: AbortSignal,
  ): Promise<TimesheetLockWindow>
  unlockTimesheetLock?(
    id: number,
    input: TimesheetUnlockInput,
    signal?: AbortSignal,
  ): Promise<TimesheetLockWindow>
  generateInvoice?(
    commandId: string,
    input: InvoiceGenerationInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
}

export interface QuickAddCommand {
  readonly seconds: number
  readonly project: string
  readonly task: string
  readonly notes?: string
}

export const maximumTimeEntryNoteLength = 10_000
export const pendingTimesheetQueueLimit = 50
export const pendingTimesheetDetailConcurrency = 4

export const hydratePendingTimesheetDetails = async (
  summaries: readonly TimesheetSubmission[],
  getSubmission: (id: number, signal?: AbortSignal) => Promise<TimesheetSubmissionDetail>,
  signal?: AbortSignal,
): Promise<readonly TimesheetSubmissionDetail[]> => {
  const bounded = summaries.slice(0, pendingTimesheetQueueLimit)
  const details: Array<TimesheetSubmissionDetail | undefined> = new Array(bounded.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < bounded.length) {
      const index = next++
      details[index] = await getSubmission(bounded[index]!.id, signal)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(pendingTimesheetDetailConcurrency, bounded.length) },
      worker,
    ),
  )
  return details.filter(
    (detail): detail is TimesheetSubmissionDetail => detail?.status === 'submitted',
  )
}

export const timeEntryNoteLength = (notes: string | null | undefined): number =>
  notes === null || notes === undefined ? 0 : Array.from(notes.trim()).length

export class TimeEntryNoteValidationError extends Error {
  readonly minimumLength: number

  constructor(minimumLength: number) {
    super(
      `A note of at least ${minimumLength} ${minimumLength === 1 ? 'character is' : 'characters are'} required for that project and task.`,
    )
    this.name = 'TimeEntryNoteValidationError'
    this.minimumLength = minimumLength
  }
}

export interface DisplayTimeEntry extends TimeEntry {
  readonly project_label: string
  readonly task_label: string
}

export interface ShellSnapshot {
  readonly entries: readonly DisplayTimeEntry[]
  readonly expenses: readonly Expense[]
  readonly running: DisplayTimeEntry | null
  readonly timeEntrySettings: TimeEntrySettings
  readonly catalog: {
    readonly projects: readonly GeneralResource[]
    readonly tasks: readonly GeneralResource[]
    readonly timeEntryOptions: readonly TimeEntryOption[]
  }
}

const navigation = new Map([
  ['time', '/'],
  ['expenses', '/expenses'],
  ['projects', '/projects'],
  ['clients', '/clients'],
  ['invoices', '/invoices'],
  ['reports', '/reports'],
])

const resourceText = (
  resource: GeneralResource,
  field: string,
): string | null => {
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

const resourceLabel = (resource: GeneralResource): string =>
  resourceText(resource, 'name') ??
  resourceText(resource, 'code') ??
  `#${resource.id}`

const resourceAliases = (resource: GeneralResource): readonly string[] =>
  [
    resourceText(resource, 'name'),
    resourceText(resource, 'code'),
    String(resource.id),
  ].filter((value): value is string => value !== null)

const normalized = (value: string): string =>
  value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')

const collect = async (
  load: (cursor?: string) => Promise<CursorPage<GeneralResource>>,
  signal?: AbortSignal,
): Promise<GeneralResource[]> => {
  const resources: GeneralResource[] = []
  let cursor: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await load(cursor)
    resources.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return resources
}

const loadCatalogResources = async (
  api: ShellApi,
  signal?: AbortSignal,
): Promise<{ projects: GeneralResource[]; tasks: GeneralResource[] }> => {
  const [projects, tasks] = await Promise.all([
    collect((cursor) => api.listProjects(cursor, signal), signal),
    collect((cursor) => api.listTasks(cursor, signal), signal),
  ])
  return { projects, tasks }
}

const assertNoteIsAllowed = (
  notes: string | null | undefined,
  minimumLength: number,
): void => {
  if (
    notes !== null &&
    notes !== undefined &&
    notes.length > maximumTimeEntryNoteLength
  ) {
    throw new Error(
      `Notes cannot exceed ${maximumTimeEntryNoteLength.toLocaleString('en-US')} characters.`,
    )
  }
  const length = timeEntryNoteLength(notes)
  if (length < minimumLength) {
    throw new TimeEntryNoteValidationError(minimumLength)
  }
}

const resolveAvailableEntrySelection = async (
  api: ShellApi,
  projectValue: string,
  taskValue: string,
  signal?: AbortSignal,
): Promise<{
  project: GeneralResource
  task: GeneralResource
  minimumNoteLength: number
}> => {
  const [resources, options] = await Promise.all([
    loadCatalogResources(api, signal),
    api.listTimeEntryOptions(signal),
  ])
  const project = resolveResource('project', projectValue, resources.projects)
  const task = resolveResource('task', taskValue, resources.tasks)
  const selected = options.find(
    (option) =>
      option.project_id === project.id && option.task_id === task.id,
  )
  if (selected === undefined) {
    throw new Error('That project and task combination is not available.')
  }
  return {
    project,
    task,
    minimumNoteLength: selected.minimum_note_length,
  }
}

const resolveResource = (
  kind: 'project' | 'task',
  value: string,
  resources: readonly GeneralResource[],
): GeneralResource => {
  const wanted = normalized(value)
  const matches = resources.filter((resource) =>
    resourceAliases(resource).some((alias) => normalized(alias) === wanted),
  )
  if (matches.length === 0) throw new Error(`${kind} not found: ${value}`)
  if (matches.length > 1) throw new Error(`${kind} is ambiguous: ${value}`)
  return matches[0]!
}

export const parseDurationSeconds = (value: string): number => {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/iu.exec(value)
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new Error('duration must look like 2h, 90m, or 1h30m')
  }
  const seconds = Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error('duration must resolve to whole positive seconds')
  }
  return seconds
}

export const parseQuickAdd = (value: string): QuickAddCommand => {
  const tokens = /^log\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/iu.exec(
    value.trim(),
  )
  if (tokens === null) {
    throw new Error('use: log 2h project task [note]')
  }
  const notes = tokens[4]?.trim()
  return {
    seconds: parseDurationSeconds(tokens[1]!),
    project: tokens[2]!,
    task: tokens[3]!,
    ...(notes === undefined || notes === '' ? {} : { notes }),
  }
}

export const navigationDestination = (value: string): string | null => {
  const match = /^go\s+(.+)$/iu.exec(value.trim())
  return match === null ? null : (navigation.get(normalized(match[1]!)) ?? null)
}

export const localDate = (now = new Date()): string => {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const weekRange = (
  within: string,
  weekStartDay: 'saturday' | 'sunday' | 'monday' = 'monday',
): { from: string; to: string } => {
  const date = new Date(`${within}T00:00:00.000Z`)
  const startIndex = weekStartDay === 'sunday' ? 0 : weekStartDay === 'monday' ? 1 : 6
  const daysSinceStart = (date.getUTCDay() - startIndex + 7) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceStart)
  const from = date.toISOString().slice(0, 10)
  date.setUTCDate(date.getUTCDate() + 6)
  return { from, to: date.toISOString().slice(0, 10) }
}

export const runningElapsedSeconds = (
  entry: TimeEntry,
  now = new Date(),
): number => {
  if (
    !entry.is_running ||
    entry.timer_started_at === null ||
    entry.timer_started_at === undefined
  ) {
    return entry.seconds
  }
  const started = new Date(entry.timer_started_at).valueOf()
  return (
    entry.seconds + Math.max(0, Math.floor((now.valueOf() - started) / 1_000))
  )
}

const labels = (resources: readonly GeneralResource[]): Map<number, string> =>
  new Map(resources.map((resource) => [resource.id, resourceLabel(resource)]))

const displayEntries = (
  entries: readonly TimeEntry[],
  resources: {
    projects: readonly GeneralResource[]
    tasks: readonly GeneralResource[]
  },
): DisplayTimeEntry[] => {
  const projects = labels(resources.projects)
  const tasks = labels(resources.tasks)
  return entries.map((entry) => ({
    ...entry,
    project_label: projects.get(entry.project_id) ?? `#${entry.project_id}`,
    task_label: tasks.get(entry.task_id) ?? `#${entry.task_id}`,
  }))
}

export const loadShellSnapshot = async (
  api: ShellApi,
  now = new Date(),
  signal?: AbortSignal,
): Promise<ShellSnapshot> => {
  const timeEntrySettings = await api.getTimeEntrySettings(signal)
  const range = weekRange(localDate(now), timeEntrySettings.week_start_day)
  const expenseRequest = api.listExpenses?.(range, signal).catch((error: unknown) => {
    if (error instanceof EzactoApiError && error.status === 404) return []
    throw error
  }) ?? Promise.resolve([])
  const [resources, entries, running, expenses, timeEntryOptions] = await Promise.all([
    loadCatalogResources(api, signal),
    api.listTimeEntries(range, signal),
    api.listTimeEntries({ is_running: true }, signal),
    expenseRequest,
    api.listTimeEntryOptions(signal),
  ])
  const displayedEntries = displayEntries(entries, resources)
  const displayedRunning = displayEntries(running, resources)
  if (displayedRunning.length > 1)
    throw new Error('more than one timer is running')
  return {
    entries: displayedEntries,
    expenses,
    running: displayedRunning[0] ?? null,
    timeEntrySettings,
    catalog: { ...resources, timeEntryOptions },
  }
}

export const prepareQuickAdd = async (
  api: ShellApi,
  value: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<{ input: TimeEntryInput; minimumNoteLength: number }> => {
  const command = parseQuickAdd(value)
  const selection = await resolveAvailableEntrySelection(
    api,
    command.project,
    command.task,
    signal,
  )
  return {
    input: {
      project_id: selection.project.id,
      task_id: selection.task.id,
      spent_date: localDate(now),
      seconds: command.seconds,
      ...(command.notes === undefined ? {} : { notes: command.notes }),
    },
    minimumNoteLength: selection.minimumNoteLength,
  }
}

export const quickAddInput = async (
  api: ShellApi,
  value: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<TimeEntryInput> => {
  const draft = await prepareQuickAdd(api, value, now, signal)
  assertNoteIsAllowed(draft.input.notes, draft.minimumNoteLength)
  return draft.input
}

export const quickAdd = async (
  api: ShellApi,
  value: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<TimeEntry> => {
  const input = await quickAddInput(api, value, now, signal)
  return signal === undefined ? api.createTimeEntry(input) : api.createTimeEntry(input, signal)
}

export const startTimer = async (
  api: ShellApi,
  projectValue: string,
  taskValue: string,
  signal?: AbortSignal,
  notes?: string,
): Promise<TimeEntry> => {
  const selection = await resolveAvailableEntrySelection(
    api,
    projectValue,
    taskValue,
    signal,
  )
  assertNoteIsAllowed(notes, selection.minimumNoteLength)
  const input: TimeEntryInput = {
    project_id: selection.project.id,
    task_id: selection.task.id,
    ...(notes === undefined || notes.trim() === '' ? {} : { notes }),
  }
  return signal === undefined
    ? api.createTimeEntry(input)
    : api.createTimeEntry(input, signal)
}

const withSignal = (signal?: AbortSignal): { signal?: AbortSignal } =>
  signal === undefined ? {} : { signal }

export const createShellApi = (client: EzactoClient): ShellApi => ({
  whoami: async (signal) => {
    return (await client.getWhoami(withSignal(signal))).data
  },
  signIn: async (credentials, signal) => {
    return (await client.signIn({ body: credentials, ...withSignal(signal) })).data
  },
  logoutCurrentSession: async (signal) => {
    const current = (await client.listSessions(withSignal(signal))).data.find(
      (session) => session.current,
    )
    if (current === undefined) {
      throw new Error('The current session could not be found.')
    }
    return (
      await client.revokeSession({
        sessionId: current.id,
        ...withSignal(signal),
      })
    ).data
  },
  listProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listDirectoryClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getDirectoryClient: async (id, signal) =>
    (await client.getClient({ id, ...withSignal(signal) })).data,
  createDirectoryClient: async (input, signal) =>
    (await client.createClient({ body: input, ...withSignal(signal) })).data,
  updateDirectoryClient: async (id, input, signal) =>
    (await client.updateClient({ id, body: input, ...withSignal(signal) })).data,
  archiveDirectoryClient: async (id, signal) => {
    await client.deleteClient({ id, ...withSignal(signal) })
  },
  listClientContacts: (clientId, cursor, signal) =>
    client.listContacts({
      query: {
        client_id: clientId,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createClientContact: async (input, signal) =>
    (await client.createContact({ body: input, ...withSignal(signal) })).data,
  updateClientContact: async (id, input, signal) =>
    (await client.updateContact({ id, body: input, ...withSignal(signal) })).data,
  deleteClientContact: async (id, signal) => {
    await client.deleteContact({ id, ...withSignal(signal) })
  },
  listClientProjects: (clientId, cursor, signal) =>
    client.listProjects({
      query: {
        client_id: clientId,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listDirectoryProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listProjectClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listReportClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listReportProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getUninvoicedReport: async (filter, signal) =>
    (
      await client.getUninvoicedReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getClientRollupReport: async (clientId, filter, signal) =>
    (
      await client.getClientRollupReport({
        clientId,
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getProjectBudgetReport: async (projectId, filter, signal) =>
    (
      await client.getProjectBudgetReport({
        projectId,
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getDirectoryProject: async (id, signal) =>
    (await client.getProject({ id, ...withSignal(signal) })).data,
  createDirectoryProject: async (input, signal) =>
    (await client.createProject({ body: input, ...withSignal(signal) })).data,
  updateDirectoryProject: async (id, input, signal) =>
    (await client.updateProject({ id, body: input, ...withSignal(signal) })).data,
  archiveDirectoryProject: async (id, signal) => {
    await client.deleteProject({ id, ...withSignal(signal) })
  },
  listDirectoryTasks: (cursor, signal) =>
    client.listTasks({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listProjectTaskAssignments: (projectId, cursor, signal) =>
    client.listTaskAssignments({
      query: {
        project_id: projectId,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createProjectTaskAssignment: async (input, signal) =>
    (await client.createTaskAssignment({ body: input, ...withSignal(signal) })).data,
  updateProjectTaskAssignment: async (id, input, signal) =>
    (await client.updateTaskAssignment({ id, body: input, ...withSignal(signal) })).data,
  archiveProjectTaskAssignment: async (id, signal) => {
    await client.deleteTaskAssignment({ id, ...withSignal(signal) })
  },
  listDirectoryProjectAttachments: async (projectId, signal) =>
    (await client.listProjectAttachments({ projectId, ...withSignal(signal) })).data,
  uploadDirectoryProjectAttachment: async (projectId, commandId, body, signal) =>
    (
      await client.createProjectAttachment({
        projectId,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  listInvoices: (cursor, signal) =>
    client.listInvoices({
      query: {
        per_page: 50,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getInvoice: async (id, signal) =>
    (await client.getInvoice({ id, ...withSignal(signal) })).data,
  listInvoiceMessages: async (id, signal) =>
    (await client.listInvoiceMessages({ id, ...withSignal(signal) })).data,
  listInvoicePayments: async (id, signal) =>
    (await client.listInvoicePayments({ id, ...withSignal(signal) })).data,
  listTasks: (cursor, signal) =>
    client.listTasks({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listTimeEntryOptions: async (signal) =>
    (await client.listTimeEntryOptions(withSignal(signal))).data,
  getTimeEntrySettings: async (signal) =>
    (await client.getTimeEntrySettings(withSignal(signal))).data,
  listTimeEntries: async (query, signal) => {
    const entries: TimeEntry[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTimeEntries({
        query: {
          ...query,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      entries.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return entries
  },
  listExpenses: async (query, signal) => {
    const expenses: Expense[] = []
    let cursor: string | undefined
    do {
      const page = await client.listExpenses({
        query: {
          ...query,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      expenses.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return expenses
  },
  createTimeEntry: async (input, signal) =>
    (await client.createTimeEntry({ body: input, ...withSignal(signal) })).data,
  updateTimeEntry: async (id, patch, signal) =>
    (await client.updateTimeEntry({ id, body: patch, ...withSignal(signal) })).data,
  deleteTimeEntry: async (id, signal) => {
    await client.deleteTimeEntry({ id, ...withSignal(signal) })
  },
  stopTimeEntry: async (id, signal) =>
    (await client.stopTimeEntry({ id, ...withSignal(signal) })).data,
  listTimesheetSubmissions: async (periodStart, periodEnd, signal) => {
    const submissions: TimesheetSubmission[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTimesheetSubmissions({
        query: {
          period_start: periodStart,
          period_end: periodEnd,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      submissions.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return submissions
  },
  submitTimesheet: async (input, signal) =>
    (await client.submitTimesheet({ body: input, ...withSignal(signal) })).data,
  listPendingTimesheetSubmissions: async (signal) => {
    const page = await client.listPendingTimesheetSubmissions({
      query: { per_page: pendingTimesheetQueueLimit },
      ...withSignal(signal),
    })
    return page.data.slice(0, pendingTimesheetQueueLimit)
  },
  listApprovedTimesheetSubmissions: async (periodStart, signal) => {
    const page = await client.listApprovedTimesheetSubmissions({
      query: { period_start: periodStart, per_page: pendingTimesheetQueueLimit },
      ...withSignal(signal),
    })
    return page.data.slice(0, pendingTimesheetQueueLimit)
  },
  getTimesheetSubmission: async (id, signal) =>
    (await client.getTimesheetSubmission({ id, ...withSignal(signal) })).data,
  approveTimesheetSubmission: async (id, signal) =>
    (
      await client.approveTimesheetSubmission({
        id,
        ...withSignal(signal),
      })
    ).data,
  rejectTimesheetSubmission: async (id, input, signal) =>
    (
      await client.rejectTimesheetSubmission({
        id,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  withdrawTimesheetSubmission: async (id, input, signal) =>
    (
      await client.withdrawTimesheetSubmission({
        id,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  getTimesheetLockPolicy: async (signal) =>
    (await client.getTimesheetLockPolicy(withSignal(signal))).data,
  updateTimesheetLockPolicy: async (input, signal) =>
    (
      await client.updateTimesheetLockPolicy({
        body: input,
        ...withSignal(signal),
      })
    ).data,
  listTimesheetLocks: async (signal) => {
    const locks: TimesheetLockWindow[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTimesheetLocks({
        query: {
          active: true,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      locks.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return locks
  },
  createTimesheetManualLock: async (commandId, input, signal) =>
    (
      await client.createTimesheetManualLock({
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  unlockTimesheetLock: async (id, input, signal) =>
    (
      await client.unlockTimesheetLock({
        id,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  generateInvoice: async (commandId, input, signal) =>
    (
      await client.generateInvoice({
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,
})

export const createSameOriginShellApi = (): ShellApi =>
  createShellApi(
    new EzactoClient({
      baseUrl: globalThis.location.origin,
      fetch: (input, init) =>
        globalThis.fetch(input, { ...init, credentials: 'same-origin' }),
    }),
  )
