import type BetterSqlite3 from 'better-sqlite3'
import {
  csvNameKey,
  type CsvImportDestinationScope,
  type CsvBrowserSetupKind,
  type CsvPlanInput,
} from '@ezacto/core'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  previewTimesheetLockedDates,
  type TimesheetLockPolicySettings,
  type TimesheetLockPreviewWindow,
} from './timesheet-lock-policy.js'
import type { CompiledQuery } from './tracked-state.js'

const digest = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)))
export interface CsvPendingSetup {
  kind: CsvBrowserSetupKind
  entityIdSql: string
  entityIdParams: readonly unknown[]
}
const tables: Record<CsvBrowserSetupKind, string> = {
  users: 'users',
  clients: 'clients',
  projects: 'projects',
  tasks: 'tasks',
  'user-assignments': 'user_assignments',
  'task-assignments': 'task_assignments',
}
const policyColumns: Record<CsvBrowserSetupKind, string[]> = {
  users: [
    'id',
    'first_name',
    'last_name',
    'is_active',
    'profile',
    'time_entry_notes_minimum_length',
    'has_access_to_all_future_projects',
  ],
  clients: ['id', 'name', 'is_active', 'currency'],
  projects: [
    'id',
    'client_id',
    'name',
    'is_active',
    'billing_method',
    'bill_by',
    'hourly_rate_cents',
    'billing_currency',
    'time_entry_notes_minimum_length',
    'time_rounding_mode',
    'time_rounding_minutes',
  ],
  tasks: [
    'id',
    'name',
    'is_active',
    'is_default',
    'billable_by_default',
    'default_hourly_rate_cents',
  ],
  'user-assignments': [
    'id',
    'user_id',
    'project_id',
    'is_active',
    'is_project_manager',
    'use_default_rates',
    'hourly_rate_cents',
    'time_entry_notes_minimum_length',
  ],
  'task-assignments': ['id', 'project_id', 'task_id', 'is_active', 'billable', 'hourly_rate_cents'],
}
const group = (query: string, columns: readonly string[]): string =>
  `(SELECT json_group_array(json_array(${columns.map((column) => `q.${column}`).join(',')})) FROM (${query}) q)`

/** Register only deterministic, local functions. Never exported as a Worker/D1 runtime capability. */
export const registerCsvImportSqliteFunctions = (sqlite: BetterSqlite3.Database): void => {
  sqlite.function('ez_csv_name_hash', { deterministic: true }, (value: unknown) =>
    digest(csvNameKey(String(value))),
  )
  sqlite.function('ez_csv_email_hash', { deterministic: true }, (value: unknown) =>
    digest(String(value).trim().toLowerCase()),
  )
  sqlite.function('ez_csv_sha256', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? digest(value) : null,
  )
  sqlite.function(
    'ez_csv_lock_bits',
    { deterministic: true },
    (rawSettings: unknown, rawWindows: unknown, rawDates: unknown, instant: unknown) => {
      const settings = JSON.parse(String(rawSettings)) as TimesheetLockPolicySettings
      const windows = (
        JSON.parse(String(rawWindows)) as [
          TimesheetLockPreviewWindow['kind'],
          string | null,
          string,
          string | null,
        ][]
      ).map(([kind, period_start, period_end, unlocked_at]) => ({
        kind,
        period_start,
        period_end,
        unlocked_at,
      }))
      return JSON.stringify([
        ...previewTimesheetLockedDates(
          settings,
          windows,
          JSON.parse(String(rawDates)) as string[],
          String(instant),
        ),
      ])
    },
  )
}

/** One native canonical expression reused for initial digest and atomic guards. */
export const csvImportDestinationFacts = (
  scope: CsvImportDestinationScope,
  sourceId: string,
  pending?: CsvPendingSetup,
  clock: CompiledQuery = { sql: "strftime('%Y-%m-%dT%H:%M:%fZ','now')", params: [] },
): CompiledQuery => {
  // Values are bound JSON. The only interpolated SQL identifiers come from closed tables/columns above.
  const params: unknown[] = []
  const bind = (value: unknown): string => {
    params.push(value)
    return '?'
  }
  const runId = () =>
    `(SELECT id FROM csv_import_runs WHERE source_id=${bind(sourceId)} AND browser_plan_json IS NOT NULL)`
  const own = (kind: CsvBrowserSetupKind, alias: string): string => {
    let text = `NOT EXISTS(SELECT 1 FROM csv_import_setup own WHERE own.run_id=${runId()} AND own.entity_kind='${kind}' AND own.entity_id=${alias}.id)`
    if (pending?.kind === kind) {
      text += ` AND ${alias}.id<>(${pending.entityIdSql})`
      params.push(...pending.entityIdParams)
    }
    return text
  }
  const name = (column: string, hashes: readonly string[]) =>
    `ez_csv_name_hash(${column}) IN(SELECT value FROM json_each(${bind(JSON.stringify(hashes))}))`
  const email = () =>
    `ez_csv_email_hash(e.address) IN(SELECT value FROM json_each(${bind(JSON.stringify(scope.emailHashes))}))`
  const ids = (values: readonly number[] | undefined) =>
    `SELECT value FROM json_each(${bind(JSON.stringify(values ?? []))})`
  const people = () =>
    `SELECT u.id FROM users u WHERE(u.id IN(${ids(scope.personIds)}) OR EXISTS(SELECT 1 FROM user_emails e WHERE e.user_id=u.id AND e.verified_at IS NOT NULL AND e.invalidated_at IS NULL AND ${email()})) AND ${own('users', 'u')}`
  const projects = () =>
    `SELECT p.id FROM projects p JOIN clients c ON c.id=p.client_id WHERE(p.id IN(${ids(scope.projectIds)}) OR EXISTS(SELECT 1 FROM json_each(${bind(JSON.stringify(scope.projectPairs))}) pair WHERE ((json_extract(pair.value,'$.clientId') IS NOT NULL AND c.id=json_extract(pair.value,'$.clientId')) OR(json_extract(pair.value,'$.clientId') IS NULL AND ez_csv_name_hash(c.name)=json_extract(pair.value,'$.client'))) AND ez_csv_name_hash(p.name)=json_extract(pair.value,'$.project'))) AND ${own('projects', 'p')}`
  const tasks = () =>
    `SELECT t.id FROM tasks t WHERE(t.id IN(${ids(scope.taskIds)}) OR ${name('t.name', scope.taskHashes)}) AND ${own('tasks', 't')}`
  const sections: string[] = []
  sections.push(
    group(
      'SELECT time_entry_mode,currency,time_rounding_mode,time_rounding_minutes,time_entry_notes_required,time_entry_notes_minimum_length,auto_lock,timesheet_deadline,week_start_day,timezone FROM organizations WHERE id=1',
      [
        'time_entry_mode',
        'currency',
        'time_rounding_mode',
        'time_rounding_minutes',
        'time_entry_notes_required',
        'time_entry_notes_minimum_length',
        'auto_lock',
        'timesheet_deadline',
        'week_start_day',
        'timezone',
      ],
    ),
  )
  sections.push(
    group(
      `SELECT * FROM clients c WHERE(c.id IN(${ids(scope.clientIds)}) OR ${name('c.name', scope.clientHashes)}) AND ${own('clients', 'c')} ORDER BY c.id`,
      policyColumns.clients,
    ),
  )
  sections.push(
    group(`SELECT * FROM projects WHERE id IN(${projects()}) ORDER BY id`, policyColumns.projects),
  )
  sections.push(
    group(
      `SELECT * FROM tasks t WHERE (t.id IN(${tasks()})${scope.includeProjectDefaults ? ' OR(t.is_default=1 AND t.is_active=1)' : ''}) AND ${own('tasks', 't')} ORDER BY t.id`,
      policyColumns.tasks,
    ),
  )
  sections.push(
    group(
      `SELECT * FROM users u WHERE (u.id IN(${people()})${scope.includeProjectDefaults ? ' OR(u.is_active=1 AND u.has_access_to_all_future_projects=1)' : ''}) AND ${own('users', 'u')} ORDER BY u.id`,
      [
        'id',
        'is_active',
        'profile',
        'time_entry_notes_minimum_length',
        'has_access_to_all_future_projects',
      ],
    ),
  )
  sections.push(
    group(
      `SELECT e.id,e.user_id,e.address,e.verified_at,e.invalidated_at FROM user_emails e JOIN users u ON u.id=e.user_id WHERE ${email()} AND ${own('users', 'u')} ORDER BY e.id`,
      ['id', 'user_id', 'address', 'verified_at', 'invalidated_at'],
    ),
  )
  sections.push(
    group(
      `SELECT * FROM user_assignments a WHERE a.user_id IN(${people()}) AND a.project_id IN(${projects()}) AND ${own('user-assignments', 'a')} ORDER BY a.id`,
      policyColumns['user-assignments'],
    ),
  )
  sections.push(
    group(
      `SELECT * FROM task_assignments a WHERE a.project_id IN(${projects()}) AND a.task_id IN(${tasks()}) AND ${own('task-assignments', 'a')} ORDER BY a.id`,
      policyColumns['task-assignments'],
    ),
  )
  for (const table of ['user_billable_rates', 'user_cost_rates'])
    sections.push(
      group(`SELECT * FROM ${table} WHERE user_id IN(${people()}) ORDER BY id`, [
        'id',
        'user_id',
        'amount_cents',
        'start_date',
        'end_date',
      ]),
    )
  sections.push(
    group(
      `SELECT * FROM timesheet_submissions WHERE user_id IN(${people()}) AND status IN('submitted','approved') AND EXISTS(SELECT 1 FROM json_each(${bind(JSON.stringify(scope.dates))}) date WHERE date.value BETWEEN period_start AND period_end) ORDER BY id`,
      ['id', 'user_id', 'period_start', 'period_end', 'status'],
    ),
  )
  sections.push(
    group(
      `SELECT * FROM timesheet_lock_windows WHERE EXISTS(SELECT 1 FROM json_each(${bind(JSON.stringify(scope.dates))}) date WHERE date.value<=period_end AND(period_start IS NULL OR date.value>=period_start)) ORDER BY id`,
      ['id', 'kind', 'period_start', 'period_end', 'unlocked_at'],
    ),
  )
  const clockSettings = `(SELECT json_object('autoLock',json(CASE auto_lock WHEN 1 THEN 'true' ELSE 'false' END),'timesheetDeadline',json(timesheet_deadline),'weekStartDay',week_start_day,'timezone',timezone,'updatedAt','') FROM organizations WHERE id=1)`
  const clockWindows = group(
    `SELECT * FROM timesheet_lock_windows WHERE EXISTS(SELECT 1 FROM json_each(${bind(JSON.stringify(scope.dates))}) date WHERE date.value<=period_end AND(period_start IS NULL OR date.value>=period_start)) ORDER BY id`,
    ['kind', 'period_start', 'period_end', 'unlocked_at'],
  )
  sections.push(
    `ez_csv_lock_bits(${clockSettings},${clockWindows},${bind(JSON.stringify(scope.dates))},(${clock.sql}))`,
  )
  params.push(...clock.params)
  return { sql: `json_array(${sections.map((section) => `json(${section})`).join(',')})`, params }
}

export const csvImportSetupFacts = (
  kind: CsvBrowserSetupKind,
  entityIdSql: string,
  entityIdParams: readonly unknown[],
  pending?: CsvPendingSetup,
): CompiledQuery => {
  const target = '(SELECT id FROM csv_target)'
  const sections = [group(`SELECT * FROM ${tables[kind]} WHERE id=${target}`, policyColumns[kind])]
  const params: unknown[] = [...entityIdParams]
  if (kind === 'users')
    sections.push(
      group(
        `SELECT id,user_id,address,verified_at,invalidated_at FROM user_emails WHERE user_id=${target} ORDER BY id`,
        ['id', 'user_id', 'address', 'verified_at', 'invalidated_at'],
      ),
    )
  if (kind === 'projects')
    for (const child of ['user-assignments', 'task-assignments'] as const) {
      sections.push(
        group(
          `SELECT child.* FROM ${tables[child]} child WHERE child.project_id=${target}
      AND NOT EXISTS(SELECT 1 FROM csv_import_setup explicit_child JOIN csv_import_setup parent ON parent.run_id=explicit_child.run_id
      WHERE parent.entity_kind='projects' AND parent.entity_id=${target} AND explicit_child.entity_kind='${child}' AND explicit_child.entity_id=child.id)
      ${pending?.kind === child ? `AND child.id<>(${pending.entityIdSql})` : ''}
      ORDER BY child.id`,
          policyColumns[child],
        ),
      )
      if (pending?.kind === child) params.push(...pending.entityIdParams)
    }
  return {
    sql: `WITH csv_target(id) AS(SELECT (${entityIdSql})) SELECT ez_csv_sha256(json_array(${sections.map((section) => `json(${section})`).join(',')}))`,
    params,
  }
}

/** Server-owned manifest only; no client expression or SQL is accepted. */
export const csvImportDestinationFence = (
  plan: CsvPlanInput,
  pending?: CsvPendingSetup,
): CompiledQuery => {
  if (!plan.destinationFacts) throw new Error('destination_facts_required')
  const scope = JSON.parse(plan.destinationFacts) as CsvImportDestinationScope
  const facts = csvImportDestinationFacts(scope, plan.datasetId, pending)
  const checks: string[] = []
  const params: unknown[] = [...facts.params, plan.destinationVersion]
  for (const kind of Object.keys(tables) as CsvBrowserSetupKind[]) {
    const integrity = csvImportSetupFacts(kind, 'lineage.entity_id', [], pending)
    checks.push(
      `NOT EXISTS(SELECT 1 FROM csv_import_setup lineage JOIN csv_import_runs owned_run ON owned_run.id=lineage.run_id WHERE owned_run.source_id=? AND lineage.entity_kind='${kind}' AND(lineage.policy_facts_sha256 IS NULL OR lineage.policy_facts_sha256<>(${integrity.sql})))`,
    )
    params.push(plan.datasetId, ...integrity.params)
  }
  return { sql: `ez_csv_sha256(${facts.sql})=? AND ${checks.join(' AND ')}`, params }
}
