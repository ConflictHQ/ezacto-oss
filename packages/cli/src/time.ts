import {
  type EzactoClient,
  type GeneralResource,
  type TimeEntry,
} from '@ezacto/client'

export interface TimeCommandResult {
  json: unknown
  human: string
}

interface Catalog {
  projects: GeneralResource[]
  tasks: GeneralResource[]
  projectNames: Map<number, string>
  taskNames: Map<number, string>
}

const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const canonicalDate = (raw: string): string => {
  if (!canonicalDatePattern.test(raw)) throw new Error(`invalid date: ${raw}`)
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== raw
  ) {
    throw new Error(`invalid date: ${raw}`)
  }
  return raw
}

export const localDate = (now = new Date()): string => {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const parseDuration = (raw: string): number => {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/i.exec(raw)
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(`invalid duration: ${raw}; use values such as 2h, 90m, or 1h30m`)
  }
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error(`invalid duration: ${raw}; duration must resolve to whole positive seconds`)
  }
  return seconds
}

export const formatDuration = (seconds: number): string => {
  if (!Number.isSafeInteger(seconds)) return '—'
  // A correction entry is negative, and rendering it as an em dash reads as
  // "no value" when the value is the whole point. Format the magnitude and put
  // the sign back: Math.floor on a negative would carry the borrow the wrong
  // way, turning -1800 into -1:30 rather than -0:30.
  const sign = seconds < 0 ? '-' : ''
  const magnitude = Math.abs(seconds)
  const hours = Math.floor(magnitude / 3600)
  const minutes = Math.floor((magnitude % 3600) / 60)
  const remainder = magnitude % 60
  const base = `${sign}${hours}:${String(minutes).padStart(2, '0')}`
  return remainder === 0 ? base : `${base}:${String(remainder).padStart(2, '0')}`
}

const textField = (resource: GeneralResource, name: string): string | null => {
  const value = resource[name]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const displayName = (resource: GeneralResource): string =>
  textField(resource, 'name') ?? textField(resource, 'code') ?? `#${resource.id}`

const normalizedLabel = (value: string): string =>
  value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')

const collectGeneral = async (
  load: (cursor?: string) => ReturnType<EzactoClient['listProjects']>,
): Promise<GeneralResource[]> => {
  const records: GeneralResource[] = []
  let cursor: string | undefined
  do {
    const page = await load(cursor)
    records.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return records
}

const collectTimeEntries = async (
  client: EzactoClient,
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): Promise<TimeEntry[]> => {
  const records: TimeEntry[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTimeEntries({
      query: { ...query, per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
    })
    records.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return records
}

const catalog = async (client: EzactoClient): Promise<Catalog> => {
  const [projects, tasks] = await Promise.all([
    collectGeneral((cursor) =>
      client.listProjects({
        query: {
          per_page: 200,
          is_active: true,
          ...(cursor === undefined ? {} : { cursor }),
        },
      }),
    ),
    collectGeneral((cursor) =>
      client.listTasks({
        query: {
          per_page: 200,
          is_active: true,
          ...(cursor === undefined ? {} : { cursor }),
        },
      }),
    ),
  ])
  return {
    projects,
    tasks,
    projectNames: new Map(projects.map((resource) => [resource.id, displayName(resource)])),
    taskNames: new Map(tasks.map((resource) => [resource.id, displayName(resource)])),
  }
}

const resolveResource = (
  kind: 'project' | 'task',
  raw: string,
  resources: readonly GeneralResource[],
): GeneralResource => {
  const wanted = normalizedLabel(raw)
  const matches = resources.filter((resource) => {
    const labels = [textField(resource, 'name'), textField(resource, 'code')]
      .filter((value): value is string => value !== null)
      .map(normalizedLabel)
    return labels.includes(wanted) || String(resource.id) === raw
  })
  if (matches.length === 0) throw new Error(`${kind} not found: ${raw}`)
  if (matches.length > 1) {
    throw new Error(
      `${kind} is ambiguous: ${raw} (${matches.map(displayName).join(', ')})`,
    )
  }
  return matches[0]!
}

const entryOutput = (entry: TimeEntry, resources: Catalog) => ({
  ...entry,
  project: resources.projectNames.get(entry.project_id) ?? `#${entry.project_id}`,
  task: resources.taskNames.get(entry.task_id) ?? `#${entry.task_id}`,
})

export const logTime = async (
  client: EzactoClient,
  input: {
    duration: string
    project: string
    task: string
    date?: string
    message?: string
    now?: Date
  },
): Promise<TimeCommandResult> => {
  const resources = await catalog(client)
  const project = resolveResource('project', input.project, resources.projects)
  const task = resolveResource('task', input.task, resources.tasks)
  const seconds = parseDuration(input.duration)
  const spentDate = canonicalDate(input.date ?? localDate(input.now))
  const entry = (
    await client.createTimeEntry({
      body: {
        project_id: project.id,
        task_id: task.id,
        spent_date: spentDate,
        seconds,
        ...(input.message === undefined ? {} : { notes: input.message }),
      },
    })
  ).data
  const output = entryOutput(entry, resources)
  return {
    json: output,
    human: `logged ${formatDuration(entry.seconds)} on ${spentDate}: ${output.project} / ${output.task}${entry.notes === null ? '' : ` — ${entry.notes}`}`,
  }
}

const runningEntries = (client: EzactoClient): Promise<TimeEntry[]> =>
  collectTimeEntries(client, { is_running: true })

const exactlyOneRunning = (entries: readonly TimeEntry[]): TimeEntry => {
  if (entries.length === 0) throw new Error('no timer is running')
  if (entries.length > 1) {
    throw new Error(`server invariant violated: ${entries.length} timers are running`)
  }
  return entries[0]!
}

export const startTimer = async (
  client: EzactoClient,
  input: {
    project: string
    task: string
    date?: string
    message?: string
    now?: Date
  },
): Promise<TimeCommandResult> => {
  const resources = await catalog(client)
  const project = resolveResource('project', input.project, resources.projects)
  const task = resolveResource('task', input.task, resources.tasks)
  const entry = (
    await client.createTimeEntry({
      body: {
        project_id: project.id,
        task_id: task.id,
        spent_date: canonicalDate(input.date ?? localDate(input.now)),
        ...(input.message === undefined ? {} : { notes: input.message }),
      },
    })
  ).data
  const output = entryOutput(entry, resources)
  return {
    json: output,
    human: `timer started #${entry.id}: ${output.project} / ${output.task}${entry.notes === null ? '' : ` — ${entry.notes}`}`,
  }
}

export const timerStatus = async (
  client: EzactoClient,
): Promise<TimeCommandResult> => {
  const entries = await runningEntries(client)
  if (entries.length === 0) {
    return { json: { running: false }, human: 'timer stopped' }
  }
  const entry = exactlyOneRunning(entries)
  const resources = await catalog(client)
  const output = entryOutput(entry, resources)
  return {
    json: { running: true, entry: output },
    human: `timer running #${entry.id}: ${output.project} / ${output.task}${entry.notes === null ? '' : ` — ${entry.notes}`}`,
  }
}

export const stopTimer = async (
  client: EzactoClient,
): Promise<TimeCommandResult> => {
  const running = exactlyOneRunning(await runningEntries(client))
  const resources = await catalog(client)
  const entry = (await client.stopTimeEntry({ id: running.id })).data
  const output = entryOutput(entry, resources)
  return {
    json: output,
    human: `timer stopped #${entry.id} at ${formatDuration(entry.seconds)}: ${output.project} / ${output.task}`,
  }
}

export const weekRange = (within: string): { from: string; to: string; dates: string[] } => {
  const date = new Date(`${canonicalDate(within)}T00:00:00.000Z`)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  const dates = Array.from({ length: 7 }, (_value, index) => {
    const day = new Date(date)
    day.setUTCDate(day.getUTCDate() + index)
    return day.toISOString().slice(0, 10)
  })
  return { from: dates[0]!, to: dates[6]!, dates }
}

const weekGrid = (
  entries: readonly TimeEntry[],
  dates: readonly string[],
  resources: Catalog,
): { rows: Array<{ project: string; task: string; days: number[]; total: number }>; total: number } => {
  const grouped = new Map<
    string,
    { project: string; task: string; days: number[]; total: number }
  >()
  for (const entry of entries) {
    const project = resources.projectNames.get(entry.project_id) ?? `#${entry.project_id}`
    const task = resources.taskNames.get(entry.task_id) ?? `#${entry.task_id}`
    const key = `${entry.project_id}:${entry.task_id}`
    const row = grouped.get(key) ?? {
      project,
      task,
      days: Array.from({ length: 7 }, () => 0),
      total: 0,
    }
    const day = dates.indexOf(entry.spent_date)
    if (day >= 0) row.days[day] = (row.days[day] ?? 0) + entry.seconds
    row.total += entry.seconds
    grouped.set(key, row)
  }
  const rows = [...grouped.values()].sort(
    (left, right) =>
      left.project.localeCompare(right.project) || left.task.localeCompare(right.task),
  )
  return { rows, total: rows.reduce((sum, row) => sum + row.total, 0) }
}

const dayHeading = (date: string): string => {
  const day = new Date(`${date}T00:00:00.000Z`)
  return `${day.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${date.slice(8)}`
}

const renderWeek = (
  from: string,
  to: string,
  dates: readonly string[],
  grid: ReturnType<typeof weekGrid>,
): string => {
  const labelWidth = Math.max(
    14,
    ...grid.rows.map((row) => `${row.project} / ${row.task}`.length),
  )
  const headings = dates.map(dayHeading)
  const lines = [
    `week ${from} — ${to}`,
    `${'project / task'.padEnd(labelWidth)}  ${headings.map((heading) => heading.padStart(6)).join(' ')}  total`,
  ]
  for (const row of grid.rows) {
    const label = `${row.project} / ${row.task}`
    lines.push(
      `${label.padEnd(labelWidth)}  ${row.days.map((seconds) => (seconds === 0 ? '—' : formatDuration(seconds)).padStart(6)).join(' ')}  ${formatDuration(row.total).padStart(5)}`,
    )
  }
  if (grid.rows.length === 0) lines.push('(no time entries)')
  lines.push(`${'total'.padEnd(labelWidth)}  ${' '.repeat(48)}  ${formatDuration(grid.total).padStart(5)}`)
  return lines.join('\n')
}

export const showWeek = async (
  client: EzactoClient,
  input: { within?: string; now?: Date },
): Promise<TimeCommandResult> => {
  const range = weekRange(input.within ?? localDate(input.now))
  const [entries, resources] = await Promise.all([
    collectTimeEntries(client, { from: range.from, to: range.to }),
    catalog(client),
  ])
  const grid = weekGrid(entries, range.dates, resources)
  return {
    json: {
      from: range.from,
      to: range.to,
      dates: [...range.dates],
      entries: entries.map((entry) => entryOutput(entry, resources)),
      rows: grid.rows,
      total_seconds: grid.total,
    },
    human: renderWeek(range.from, range.to, range.dates, grid),
  }
}
