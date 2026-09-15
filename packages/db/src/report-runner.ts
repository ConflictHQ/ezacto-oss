/** Execute one report definition over live tracked time with exact drill-through (#60). */
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { MetricId, ReportDefinition, ReportFilter } from './report-definitions.js'
import type { SavedReportPresentation } from './saved-reports.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

interface PopulationRow {
  id: number
  spentDate: string
  clientId: number
  clientName: string
  projectId: number
  projectName: string
  taskId: number
  taskName: string
  userId: number
  userName: string
  roundedSeconds: number
  billable: number
  billableRateCents: number | null
  costRateCents: number | null
}

export interface ReportRunnerCell {
  readonly value: number | null
  readonly missingReason?: 'missing_rate' | 'unsupported_metric'
  readonly fixUrl?: string
}

export interface ReportRunnerRow {
  readonly key: string
  readonly label: string
  readonly fields: Readonly<Record<string, string | number | boolean>>
  readonly metrics: Readonly<Partial<Record<MetricId, ReportRunnerCell>>>
  readonly entryIds: readonly number[]
  readonly drillThrough: string
}

export interface ReportRunnerResult {
  readonly definitionId: string
  readonly definitionVersion: number
  readonly state: 'ready' | 'empty' | 'too_many_rows'
  readonly rows: readonly ReportRunnerRow[]
}

const matches = (row: PopulationRow, filter: ReportFilter): boolean => {
  const value: unknown = {
    client_id: row.clientId,
    project_id: row.projectId,
    task_id: row.taskId,
    user_id: row.userId,
    spent_date: row.spentDate,
    billable: row.billable === 1,
  }[filter.field]
  if (filter.operator === 'eq') return value === filter.value
  if (filter.operator === 'neq') return value !== filter.value
  if (filter.operator === 'in') return Array.isArray(filter.value) && filter.value.includes(value)
  const compare = (left: unknown, right: unknown): number =>
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'en-US')
  if (filter.operator === 'between') {
    return Array.isArray(filter.value) &&
      compare(value, filter.value[0]) >= 0 && compare(value, filter.value[1]) <= 0
  }
  const order = compare(value, filter.value)
  if (filter.operator === 'gt') return order > 0
  if (filter.operator === 'gte') return order >= 0
  if (filter.operator === 'lt') return order < 0
  return order <= 0
}

const dimension = (row: PopulationRow, group: ReportDefinition['groupBy']): { key: string; label: string } => {
  if (group === null) return { key: 'all', label: 'All tracked time' }
  if (group.dimension === 'client') return { key: `client:${row.clientId}`, label: row.clientName }
  if (group.dimension === 'project') return { key: `project:${row.projectId}`, label: row.projectName }
  if (group.dimension === 'task') return { key: `task:${row.taskId}`, label: row.taskName }
  if (group.dimension === 'user') return { key: `user:${row.userId}`, label: row.userName }
  return { key: `date:${row.spentDate}`, label: row.spentDate }
}

const sumRated = (rows: readonly PopulationRow[], rate: 'billableRateCents' | 'costRateCents'): number | null => {
  if (rows.some((row) => row[rate] === null)) return null
  return rows.reduce((total, row) => total + Math.round(row.roundedSeconds * row[rate]! / 3_600), 0)
}

export const runReportDefinition = async (
  database: Database,
  definition: ReportDefinition,
  presentation: SavedReportPresentation,
  authority: Readonly<{ billableMoney: boolean; costMoney: boolean }>,
): Promise<ReportRunnerResult> => {
  const population = (await database.all<PopulationRow>(sql`
    SELECT entry.id, entry.spent_date AS "spentDate", client.id AS "clientId",
      client.name AS "clientName", project.id AS "projectId", project.name AS "projectName",
      task.id AS "taskId", task.name AS "taskName", person.id AS "userId",
      person.first_name || ' ' || person.last_name AS "userName",
      entry.rounded_seconds AS "roundedSeconds", entry.billable,
      entry.billable_rate_cents AS "billableRateCents", entry.cost_rate_cents AS "costRateCents"
    FROM time_entries entry
    JOIN projects project ON project.id = entry.project_id
    JOIN clients client ON client.id = project.client_id
    JOIN tasks task ON task.id = entry.task_id
    JOIN users person ON person.id = entry.user_id
    ORDER BY entry.spent_date, entry.id LIMIT 10001`)).filter((row) =>
      definition.filters.every((filter) => matches(row, filter)),
    )
  if (population.length > 10_000) return { definitionId: definition.id, definitionVersion: definition.version, state: 'too_many_rows', rows: [] }
  const groups = new Map<string, { label: string; rows: PopulationRow[] }>()
  for (const row of population) {
    const grouped = presentation.grouped ? dimension(row, definition.groupBy) : { key: `entry:${row.id}`, label: `${row.spentDate} · ${row.projectName}` }
    const bucket = groups.get(grouped.key) ?? { label: grouped.label, rows: [] }
    bucket.rows.push(row)
    groups.set(grouped.key, bucket)
  }
  const rows = [...groups.entries()].map(([key, bucket]): ReportRunnerRow => {
    const billable = sumRated(bucket.rows.filter((row) => row.billable === 1), 'billableRateCents')
    const cost = sumRated(bucket.rows, 'costRateCents')
    const metric = (id: MetricId): ReportRunnerCell | undefined => {
      if (!definition.metrics.includes(id)) return undefined
      if (id === 'hours') return { value: bucket.rows.reduce((sum, row) => sum + row.roundedSeconds, 0) }
      if (id === 'billable') return authority.billableMoney ? (billable === null ? { value: null, missingReason: 'missing_rate', fixUrl: `/team/${bucket.rows.find((row) => row.billableRateCents === null)?.userId ?? ''}/rates` } : { value: billable }) : undefined
      if (id === 'cost') return authority.costMoney ? (cost === null ? { value: null, missingReason: 'missing_rate', fixUrl: `/team/${bucket.rows.find((row) => row.costRateCents === null)?.userId ?? ''}/rates` } : { value: cost }) : undefined
      if (id === 'margin') return authority.billableMoney && authority.costMoney
        ? billable === null || cost === null ? { value: null, missingReason: 'missing_rate', fixUrl: `/team/${bucket.rows.find((row) => row.billableRateCents === null || row.costRateCents === null)?.userId ?? ''}/rates` } : { value: billable - cost }
        : undefined
      if (id === 'utilisation') {
        const all = bucket.rows.reduce((sum, row) => sum + row.roundedSeconds, 0)
        const billed = bucket.rows.filter((row) => row.billable === 1).reduce((sum, row) => sum + row.roundedSeconds, 0)
        return { value: all === 0 ? null : Math.round(billed * 1_000_000 / all) }
      }
      return { value: null, missingReason: 'unsupported_metric' }
    }
    const metrics = Object.fromEntries(definition.metrics.flatMap((id) => {
      const cell = metric(id)
      return cell === undefined ? [] : [[id, cell]]
    })) as Partial<Record<MetricId, ReportRunnerCell>>
    const first = bucket.rows[0]!
    const params = new URLSearchParams({ report: 'detailed-time', grain: 'entry', from: bucket.rows[0]!.spentDate, to: bucket.rows.at(-1)!.spentDate })
    if (key.startsWith('client:')) params.set('client_id', String(first.clientId))
    if (key.startsWith('project:')) params.set('project_id', String(first.projectId))
    if (key.startsWith('task:')) params.set('task_id', String(first.taskId))
    if (key.startsWith('user:')) params.set('user_id', String(first.userId))
    const fields = Object.fromEntries(definition.fields.filter(({ visible }) => visible).map(({ id }) => [id, ({
      client_id: first.clientId, client_name: first.clientName, project_id: first.projectId,
      project_name: first.projectName, task_id: first.taskId, task_name: first.taskName,
      user_id: first.userId, user_name: first.userName, spent_date: first.spentDate,
      billable: first.billable === 1,
    } as Record<string, string | number | boolean>)[id]!]))
    return { key, label: bucket.label, fields, metrics, entryIds: bucket.rows.map(({ id }) => id), drillThrough: `/reports?${params.toString()}` }
  }).filter((row) => presentation.includeZeroValues || Object.values(row.metrics).some((cell) => cell?.value !== 0))
  return { definitionId: definition.id, definitionVersion: definition.version, state: rows.length === 0 ? 'empty' : 'ready', rows }
}
