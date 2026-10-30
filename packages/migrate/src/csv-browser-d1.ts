import { CsvBrowserPlannerError, assertCsvExporterZone } from './csv-browser-errors.js'
import { previewTimesheetLockedDates, type TimesheetLockPolicySettings, type TimesheetLockPreviewWindow } from '@ezacto/db/d1'
import type { AdministratorActor, CsvPlanInput } from '@ezacto/core'
import { parseCsv } from './csv-contract.js'
import { createClockifyBrowserAdapter, CLOCKIFY_ADAPTERS } from './csv-clockify.js'
import { sha256Hex } from './portable-hash.js'
import { canonicalMapping, emptyMapping } from './csv-mapping.js'
import { assertBrowserMappingSources, type CsvBrowserMapping } from './csv-browser-mapping.js'
import { csvBrowserSealInput, planCsvImportFromSnapshot, type CsvBrowserDestinationSnapshot } from './csv-planner.js'

const MAX_SNAPSHOT_ROWS = 5000
interface SnapshotTable { sql: string; bindings?: unknown[] }

/** One real read-only D1 batch provides a consistent bounded destination view.
 * No schema writes, rollback emulation, custom SQLite function or hidden owner. */
export const readD1CsvDestinationSnapshot = async (
  database: D1Database,
  actor: AdministratorActor,
  sourceId: string,
  bytes: Uint8Array,
  input: { exporterZone: string; mapping?: CsvBrowserMapping; excludedLines?: readonly number[] },
  now = new Date(),
) => {
  assertCsvExporterZone(input.exporterZone)
  const parsed = parseCsv(bytes, createClockifyBrowserAdapter({ exporterZone: input.exporterZone }))
  const mapping = input.mapping ?? emptyMapping()
  assertBrowserMappingSources(mapping, parsed.rows)
  const tables: Record<string, SnapshotTable> = {
    revision: { sql: 'SELECT revision FROM csv_worker_revision WHERE singleton=1' },
    actor: { sql: "SELECT id FROM users WHERE id=? AND is_active=1 AND profile='administrator' AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=users.id)", bindings: [Number(actor.userId)] },
    organization: { sql: 'SELECT name,time_entry_mode,currency,time_rounding_mode,time_rounding_minutes,time_entry_notes_required,time_entry_notes_minimum_length,auto_lock,timesheet_deadline,week_start_day,timezone,updated_at FROM organizations WHERE id=1' },
    windows: { sql: 'SELECT kind,period_start,period_end,unlocked_at FROM timesheet_lock_windows ORDER BY id' },
    emails: { sql: 'SELECT lower(address) AS email,user_id FROM user_emails WHERE verified_at IS NOT NULL AND invalidated_at IS NULL ORDER BY id' },
    clients: { sql: 'SELECT id,name,is_active,currency,parent_client_id FROM clients ORDER BY id' },
    projects: { sql: 'SELECT id,client_id,name,is_active,billing_currency,billing_method,bill_by,hourly_rate_cents,budget_by,budget_seconds,cost_budget_cents FROM projects ORDER BY id' },
    tasks: { sql: 'SELECT id,name,is_active,billable_by_default,is_default,default_hourly_rate_cents FROM tasks ORDER BY id' },
    userAssignments: { sql: 'SELECT id,user_id,project_id,is_active,is_project_manager,use_default_rates,hourly_rate_cents FROM user_assignments ORDER BY id' },
    taskAssignments: { sql: 'SELECT id,project_id,task_id,billable,is_active,hourly_rate_cents FROM task_assignments ORDER BY id' },
    submissions: { sql: "SELECT user_id,period_start,period_end,status FROM timesheet_submissions WHERE status IN('submitted','approved') ORDER BY id" },
    billableRates: { sql: 'SELECT * FROM user_billable_rates ORDER BY id' },
    costRates: { sql: 'SELECT * FROM user_cost_rates ORDER BY id' },
    rateCards: { sql: 'SELECT * FROM client_rate_cards ORDER BY id' },
    rateVersions: { sql: 'SELECT * FROM client_rate_card_versions ORDER BY id' },
    importedKeys: { sql: 'SELECT source_key FROM csv_import_entries WHERE source_id=? ORDER BY source_key', bindings: [sourceId] },
    users: { sql: 'SELECT id,first_name,last_name,is_active,profile,time_entry_notes_minimum_length FROM users ORDER BY id' },
    projectPolicy: { sql: 'SELECT id,time_rounding_mode,time_rounding_minutes,time_entry_notes_minimum_length FROM projects ORDER BY id' },
    assignmentPolicy: { sql: 'SELECT user_id,project_id,time_entry_notes_minimum_length FROM user_assignments ORDER BY id' },
    futureProjectUserIds: { sql: 'SELECT id FROM users WHERE is_active=1 AND has_access_to_all_future_projects=1 ORDER BY id' },
    defaultTaskIds: { sql: 'SELECT id FROM tasks WHERE is_active=1 AND is_default=1 ORDER BY id' },
    importedEntries: { sql: 'SELECT i.source_key,t.rounded_seconds FROM csv_import_entries i LEFT JOIN time_entries t ON t.id=i.time_entry_id WHERE i.source_id=? ORDER BY i.source_key', bindings: [sourceId] },
    knownUserIds: { sql: 'SELECT id FROM users WHERE NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=users.id) ORDER BY id' },
    prior: { sql: 'SELECT r.browser_plan_json,r.browser_state,s.revision AS owned_revision,s.policy_hash FROM csv_import_runs r LEFT JOIN csv_worker_stages s ON s.native_run_id=r.id WHERE r.source_id=? AND r.browser_plan_json IS NOT NULL ORDER BY r.id DESC', bindings: [sourceId] },
  }
  const entries = Object.entries(tables)
  const result = await database.batch(entries.map(([, value]) => database.prepare(`${value.sql} LIMIT ${MAX_SNAPSHOT_ROWS + 1}`).bind(...(value.bindings ?? []))))
  const rows: Record<string, Record<string, unknown>[]> = {}
  let totalBytes = 0
  for (let i=0;i<entries.length;i++) {
    const value = result[i]!.results as Record<string, unknown>[]
    totalBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (value.length > MAX_SNAPSHOT_ROWS || totalBytes > 6 * 1024 * 1024) throw new CsvBrowserPlannerError('snapshot_budget_exceeded')
    rows[entries[i]![0]] = value
  }
  if (actor.kind !== 'administrator' || String(rows.actor?.[0]?.id) !== actor.userId) throw new CsvBrowserPlannerError('administrator_required')
  const organization = rows.organization?.[0]
  if (!organization) throw new CsvBrowserPlannerError('organization_required')
  const take = <K extends keyof CsvBrowserDestinationSnapshot>(key: string): CsvBrowserDestinationSnapshot[K] => rows[key] as unknown as CsvBrowserDestinationSnapshot[K]
  const excludedLines = [...new Set(input.excludedLines ?? [])].sort((a,b)=>a-b)
  const excluded = new Set(excludedLines)
  const selectedParsed = { ...parsed, rows: parsed.rows.filter(row=>!excluded.has(row.line)), invalid: parsed.invalid.filter(row=>!excluded.has(row.line)) }
  const dates = [...new Set(selectedParsed.rows.map(row=>row.date))]
  const settings: TimesheetLockPolicySettings = {
    autoLock: organization.auto_lock === 1,
    timesheetDeadline: organization.timesheet_deadline === null ? null : JSON.parse(String(organization.timesheet_deadline)),
    weekStartDay: organization.week_start_day as TimesheetLockPolicySettings['weekStartDay'], timezone: String(organization.timezone), updatedAt: String(organization.updated_at),
  }
  const policyKeys=Object.keys(rows).filter(key=>!['revision','actor','importedKeys','importedEntries','prior'].includes(key)).sort()
  const policyHash=sha256Hex(JSON.stringify(policyKeys.map(key=>[key,rows[key]!.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['updated_at','created_at'].includes(key))))])))
  const revision = Number(rows.revision?.[0]?.revision)
  if (!Number.isSafeInteger(revision)) throw new CsvBrowserPlannerError('snapshot_input_mismatch')
  const snapshot: CsvBrowserDestinationSnapshot = {
    actor: {...actor}, organization: { time_entry_mode: organization.time_entry_mode as 'duration'|'start_end', currency: String(organization.currency) }, stored: null,
    emails: take<'emails'>('emails'), clients: take<'clients'>('clients'), projects: take<'projects'>('projects'), tasks: take<'tasks'>('tasks'),
    userAssignments: take<'userAssignments'>('userAssignments'), taskAssignments: take<'taskAssignments'>('taskAssignments'), submissions: take<'submissions'>('submissions'),
    importedKeys: rows.importedKeys!.map(row=>String(row.source_key)), lockedDates: [...previewTimesheetLockedDates(settings,rows.windows as unknown as TimesheetLockPreviewWindow[],dates,now.toISOString())].filter(([,locked])=>locked).map(([date])=>date),
    users: take<'users'>('users'), organizationPolicy: { time_rounding_mode: organization.time_rounding_mode as CsvBrowserDestinationSnapshot['organizationPolicy']['time_rounding_mode'], time_rounding_minutes: Number(organization.time_rounding_minutes) as CsvBrowserDestinationSnapshot['organizationPolicy']['time_rounding_minutes'], time_entry_notes_required: Number(organization.time_entry_notes_required), time_entry_notes_minimum_length: Number(organization.time_entry_notes_minimum_length) },
    projectPolicy: take<'projectPolicy'>('projectPolicy'), assignmentPolicy: take<'assignmentPolicy'>('assignmentPolicy'), futureProjectUserIds: rows.futureProjectUserIds!.map(row=>Number(row.id)), defaultTaskIds: rows.defaultTaskIds!.map(row=>Number(row.id)),
    excludedLines, destinationVersion: policyHash, destinationFacts: '', fileSha256: parsed.sha256, mappingSha256: canonicalMapping(mapping).sha256, sourceId,
    importedEntries: rows.importedEntries!.map(row=>({sourceKey:String(row.source_key),roundedSeconds:row.rounded_seconds===null?null:Number(row.rounded_seconds)})), knownUserIds: rows.knownUserIds!.map(row=>Number(row.id)),
  }
  const record = rows.prior?.[0]
  const prior = record ? JSON.parse(String(record.browser_plan_json)) as CsvPlanInput : null
  const reuse = prior && prior.fileSha256 === parsed.sha256 && prior.mappingSha256 === snapshot.mappingSha256 && record!.policy_hash === policyHash
  snapshot.destinationFacts = reuse && prior.destinationFacts ? prior.destinationFacts : JSON.stringify({kind:'d1-policy@1',fingerprint:policyHash})
  if (reuse) snapshot.destinationVersion = prior.destinationVersion
  const plan = planCsvImportFromSnapshot(parsed,mapping,snapshot,{actor,sourceId,adapterId:CLOCKIFY_ADAPTERS.browser,exporterZone:input.exporterZone,excludedLines})
  assertD1CsvPlanBudget(csvBrowserSealInput(plan))
  return { plan, snapshot, revision, policyHash, organizationName: String(organization.name), sourceRows: parsed.rows, people: rows.users as unknown as {id:number;first_name:string;last_name:string;is_active:number}[], projectCurrencies: rows.projects as unknown as {id:number;billing_currency:string|null}[] }
}

/** The revision adapter guards every mutation, including tracked inserts and
 * native setup lineage, inside the same D1 batch. A stale prepared plan cannot
 * write after normal organization changes. */
export const D1_CSV_MAX_SEAL_BYTES = 1_500_000
export const assertD1CsvPlanBudget = (input: CsvPlanInput): number => {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength
  if(bytes>D1_CSV_MAX_SEAL_BYTES)throw new CsvBrowserPlannerError('snapshot_budget_exceeded')
  return bytes
}

export const createD1CsvBrowserService = async (
  database: D1Database,
  execution: import('@ezacto/db/d1').CsvWorkerExecution,
) => {
  const { createD1Database, csvWorkerDatabase, createCsvBrowserDatasetLedger, DrizzleTrackedResourceRepository, createTimesheetLockPolicyRepository } = await import('@ezacto/db/d1')
  const { createCsvBrowserWriter } = await import('./csv-browser-writer.js')
  const { csvBrowserSealInput } = await import('./csv-planner.js')
  const { sha256Hex } = await import('./portable-hash.js')
  const fencedDatabase = csvWorkerDatabase(database, execution)
  const orm = createD1Database(fencedDatabase)
  const ledger = createCsvBrowserDatasetLedger(orm, {
    now: () => new Date(),
    tracked: new DrizzleTrackedResourceRepository(orm, createTimesheetLockPolicyRepository(orm)),
    authorityFence: () => ({sql:'1',params:[]}),
    // These operate only inside csvWorkerDatabase's stronger revision/lease/
    // session fence; custom SQLite functions are deliberately not used in D1.
    destinationFence: () => ({sql:'1',params:[]}),
    setupFacts: () => ({sql:'?',params:[sha256Hex(execution.stageId)]}),
  })
  return {
    ledger, database: fencedDatabase,
    confirm: (actor: AdministratorActor, plan: import('./csv-planner.js').CsvBrowserPlan) => {
      if (actor.userId !== String(execution.authority.userId) || plan.actor.userId !== actor.userId || plan.rejectedRows || plan.plan.report.fileErrors.length) throw new CsvBrowserPlannerError('preview_rejected')
      const input=csvBrowserSealInput(plan);assertD1CsvPlanBudget(input);return ledger.seal(actor,input,true)
    },
    writer: (snapshot: CsvBrowserDestinationSnapshot, plan: import('./csv-planner.js').CsvBrowserPlan, cache?: import('./csv-browser-writer.js').CsvWriterSetupCache) => createCsvBrowserWriter(ledger,snapshot,plan,cache),
  }
}
