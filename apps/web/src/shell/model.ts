import {
  EzactoClient,
  type GeneralResource,
  type TimeEntry,
  type TimeEntryInput,
} from '@ezacto/client'

interface CursorPage<T> {
  readonly data: readonly T[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ShellApi {
  whoami(): Promise<void>
  listProjects(cursor?: string): Promise<CursorPage<GeneralResource>>
  listTasks(cursor?: string): Promise<CursorPage<GeneralResource>>
  listTimeEntries(query: {
    readonly from?: string
    readonly to?: string
    readonly is_running?: boolean
  }): Promise<readonly TimeEntry[]>
  createTimeEntry(input: TimeEntryInput): Promise<TimeEntry>
  stopTimeEntry(id: number): Promise<TimeEntry>
}

export interface QuickAddCommand {
  readonly seconds: number
  readonly project: string
  readonly task: string
  readonly notes?: string
}

export interface DisplayTimeEntry extends TimeEntry {
  readonly project_label: string
  readonly task_label: string
}

export interface ShellSnapshot {
  readonly entries: readonly DisplayTimeEntry[]
  readonly running: DisplayTimeEntry | null
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
): Promise<GeneralResource[]> => {
  const resources: GeneralResource[] = []
  let cursor: string | undefined
  do {
    const page = await load(cursor)
    resources.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return resources
}

const loadCatalogResources = async (
  api: ShellApi,
): Promise<{ projects: GeneralResource[]; tasks: GeneralResource[] }> => {
  const [projects, tasks] = await Promise.all([
    collect((cursor) => api.listProjects(cursor)),
    collect((cursor) => api.listTasks(cursor)),
  ])
  return { projects, tasks }
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

export const weekRange = (within: string): { from: string; to: string } => {
  const date = new Date(`${within}T00:00:00.000Z`)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
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
): Promise<ShellSnapshot> => {
  const range = weekRange(localDate(now))
  const [resources, entries, running] = await Promise.all([
    loadCatalogResources(api),
    api.listTimeEntries(range),
    api.listTimeEntries({ is_running: true }),
  ])
  const displayedEntries = displayEntries(entries, resources)
  const displayedRunning = displayEntries(running, resources)
  if (displayedRunning.length > 1)
    throw new Error('more than one timer is running')
  return { entries: displayedEntries, running: displayedRunning[0] ?? null }
}

export const quickAdd = async (
  api: ShellApi,
  value: string,
  now = new Date(),
): Promise<TimeEntry> => {
  const command = parseQuickAdd(value)
  const resources = await loadCatalogResources(api)
  const project = resolveResource(
    'project',
    command.project,
    resources.projects,
  )
  const task = resolveResource('task', command.task, resources.tasks)
  return api.createTimeEntry({
    project_id: project.id,
    task_id: task.id,
    spent_date: localDate(now),
    seconds: command.seconds,
    ...(command.notes === undefined ? {} : { notes: command.notes }),
  })
}

export const startTimer = async (
  api: ShellApi,
  projectValue: string,
  taskValue: string,
  now = new Date(),
): Promise<TimeEntry> => {
  const resources = await loadCatalogResources(api)
  const project = resolveResource('project', projectValue, resources.projects)
  const task = resolveResource('task', taskValue, resources.tasks)
  return api.createTimeEntry({
    project_id: project.id,
    task_id: task.id,
    spent_date: localDate(now),
  })
}

export const createShellApi = (client: EzactoClient): ShellApi => ({
  whoami: async () => {
    await client.getWhoami()
  },
  listProjects: (cursor) =>
    client.listProjects({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  listTasks: (cursor) =>
    client.listTasks({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  listTimeEntries: async (query) => {
    const entries: TimeEntry[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTimeEntries({
        query: {
          ...query,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
      })
      entries.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return entries
  },
  createTimeEntry: async (input) =>
    (await client.createTimeEntry({ body: input })).data,
  stopTimeEntry: async (id) => (await client.stopTimeEntry({ id })).data,
})

export const createSameOriginShellApi = (): ShellApi =>
  createShellApi(new EzactoClient({ baseUrl: globalThis.location.origin }))
