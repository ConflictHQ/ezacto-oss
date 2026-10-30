import { CsvBrowserPlannerError } from './csv-browser-errors.js'
import type BetterSqlite3 from 'better-sqlite3'
import {
  previewTimesheetLockedDates,
  registerCsvImportSqliteFunctions,
  csvImportDestinationFacts,
  type TimesheetLockPolicySettings,
  type TimesheetLockPreviewWindow,
} from '@ezacto/db'
import { csvBrowserDestinationScope, type CsvBrowserDestinationSnapshot } from './csv-planner.js'
import { sourceKeys, type ParsedCsv } from './csv-contract.js'
import { canonicalMapping, emptyMapping } from './csv-mapping.js'
import { assertBrowserMappingSources, type CsvBrowserMapping } from './csv-browser-mapping.js'
import { sha256Hex } from './portable-hash.js'

/**
 * The whole read is synchronous inside one SQLite read transaction: no awaited
 * application callback can interleave another request's write or be rolled back.
 * All statements are SELECTs. No policy materialization or staging happens here.
 */
export const readCsvDestinationSnapshot = (
  sqlite: BetterSqlite3.Database,
  options: {
    actor: { kind: 'administrator'; userId: string }
    dates?: readonly string[]
    parsed: ParsedCsv
    mapping?: CsvBrowserMapping
    excludedLines?: readonly number[]
    now: Date
    sourceId: string
  },
): CsvBrowserDestinationSnapshot =>
  sqlite
    .transaction(() => {
      registerCsvImportSqliteFunctions(sqlite)
      const mapping = options.mapping ?? emptyMapping()
      assertBrowserMappingSources(mapping, options.parsed.rows)
      const excludedLines = [...new Set(options.excludedLines ?? [])].sort((a, b) => a - b)
      const excluded = new Set(excludedLines)
      const keys = sourceKeys(options.parsed.rows),
        keyByLine = new Map(options.parsed.rows.map((row, index) => [row.line, keys[index]!]))
      const selectedParsed = {
        ...options.parsed,
        rows: options.parsed.rows.filter((row) => !excluded.has(row.line)),
        invalid: options.parsed.invalid.filter((issue) => !excluded.has(issue.line)),
      }
      const dates = [...new Set(selectedParsed.rows.map((row) => row.date))]
      const all = <T>(query: string, ...params: (string | number)[]) =>
        sqlite.prepare(query).all(...params) as T[]
      const actor = all<{ id: number }>(
        `SELECT id FROM users WHERE id=? AND is_active=1 AND profile='administrator'
    AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=users.id)`,
        Number(options.actor.userId),
      )[0]
      if (
        options.actor.kind !== 'administrator' ||
        !actor ||
        String(actor.id) !== options.actor.userId
      )
        throw new CsvBrowserPlannerError('administrator_required')
      const organization = all<
        CsvBrowserDestinationSnapshot['organization'] &
          CsvBrowserDestinationSnapshot['organizationPolicy'] & {
            auto_lock: number
            timesheet_deadline: string | null
            week_start_day: TimesheetLockPolicySettings['weekStartDay']
            timezone: string
            updated_at: string
          }
      >(`SELECT time_entry_mode,currency,time_rounding_mode,time_rounding_minutes,time_entry_notes_required,time_entry_notes_minimum_length,
    auto_lock,timesheet_deadline,week_start_day,timezone,updated_at FROM organizations WHERE id=1`)[0]
      if (!organization) throw new CsvBrowserPlannerError('organization_required')
      const settings: TimesheetLockPolicySettings = {
        autoLock: organization.auto_lock === 1,
        timesheetDeadline:
          organization.timesheet_deadline === null
            ? null
            : (JSON.parse(
                organization.timesheet_deadline,
              ) as TimesheetLockPolicySettings['timesheetDeadline']),
        weekStartDay: organization.week_start_day,
        timezone: organization.timezone,
        updatedAt: organization.updated_at,
      }
      const windows = all<TimesheetLockPreviewWindow>(
        'SELECT kind,period_start,period_end,unlocked_at FROM timesheet_lock_windows ORDER BY id',
      )
      const snapshot: CsvBrowserDestinationSnapshot = {
        actor: { ...options.actor },
        organization: {
          time_entry_mode: organization.time_entry_mode,
          currency: organization.currency,
        },
        stored: null,
        emails: all(
          'SELECT lower(address) AS email,user_id FROM user_emails WHERE verified_at IS NOT NULL AND invalidated_at IS NULL ORDER BY id',
        ),
        clients: all('SELECT id,name,is_active,currency FROM clients ORDER BY id'),
        projects: all('SELECT id,client_id,name,is_active FROM projects ORDER BY id'),
        tasks: all('SELECT id,name,is_active,billable_by_default FROM tasks ORDER BY id'),
        userAssignments: all(
          'SELECT user_id,project_id,is_active FROM user_assignments ORDER BY id',
        ),
        taskAssignments: all(
          'SELECT project_id,task_id,billable,is_active FROM task_assignments ORDER BY id',
        ),
        submissions: all(
          "SELECT user_id,period_start,period_end,status FROM timesheet_submissions WHERE status IN ('submitted','approved') ORDER BY id",
        ),
        importedKeys: all<{ source_key: string }>(
          'SELECT source_key FROM csv_import_entries WHERE source_id=? ORDER BY source_key',
          options.sourceId ?? '',
        ).map((row) => row.source_key),
        lockedDates: [
          ...previewTimesheetLockedDates(settings, windows, dates, options.now.toISOString()),
        ]
          .filter(([, locked]) => locked)
          .map(([date]) => date),
        users: all(
          'SELECT id,is_active,profile,time_entry_notes_minimum_length FROM users ORDER BY id',
        ),
        organizationPolicy: {
          time_rounding_mode: organization.time_rounding_mode,
          time_rounding_minutes: organization.time_rounding_minutes,
          time_entry_notes_required: organization.time_entry_notes_required,
          time_entry_notes_minimum_length: organization.time_entry_notes_minimum_length,
        },
        projectPolicy: all(
          'SELECT id,time_rounding_mode,time_rounding_minutes,time_entry_notes_minimum_length FROM projects ORDER BY id',
        ),
        assignmentPolicy: all(
          'SELECT user_id,project_id,time_entry_notes_minimum_length FROM user_assignments ORDER BY id',
        ),
        futureProjectUserIds: all<{ id: number }>(
          'SELECT id FROM users WHERE is_active=1 AND has_access_to_all_future_projects=1 ORDER BY id',
        ).map((row) => row.id),
        defaultTaskIds: all<{ id: number }>(
          'SELECT id FROM tasks WHERE is_active=1 AND is_default=1 ORDER BY id',
        ).map((row) => row.id),
        excludedLines,
        destinationVersion: '',
        destinationFacts: '',
        fileSha256: options.parsed.sha256,
        mappingSha256: canonicalMapping(mapping).sha256,
        sourceId: options.sourceId,
        importedEntries: all<{ source_key: string; rounded_seconds: number | null }>(
          `SELECT i.source_key,t.rounded_seconds FROM csv_import_entries i LEFT JOIN time_entries t ON t.id=i.time_entry_id WHERE i.source_id=? ORDER BY i.source_key`,
          options.sourceId,
        ).map((row) => ({ sourceKey: row.source_key, roundedSeconds: row.rounded_seconds })),
      }
      snapshot.knownUserIds = all<{ id: number }>(
        'SELECT id FROM users WHERE NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=users.id) ORDER BY id',
      ).map((row) => row.id)
      const existing = all<{ browser_plan_json: string; browser_state: string }>(
        'SELECT browser_plan_json,browser_state FROM csv_import_runs WHERE source_id=? AND browser_plan_json IS NOT NULL',
        options.sourceId,
      )[0]
      const prior = existing
        ? (JSON.parse(existing.browser_plan_json) as import('@ezacto/core').CsvPlanInput)
        : null
      // Reopening our own completed setup must retain the original resolution/default scope.
      const reuse =
        existing?.browser_state !== 'draft' &&
        prior?.fileSha256 === options.parsed.sha256 &&
        prior.mappingSha256 === snapshot.mappingSha256 &&
        prior.destinationFacts !== undefined
      snapshot.destinationFacts = reuse
        ? prior!.destinationFacts!
        : JSON.stringify(
            csvBrowserDestinationScope(
              selectedParsed,
              mapping,
              snapshot,
              selectedParsed.rows.map((row) => keyByLine.get(row.line)!),
            ),
          )
      const scope = JSON.parse(
        snapshot.destinationFacts,
      ) as import('@ezacto/core').CsvImportDestinationScope
      const facts = csvImportDestinationFacts(scope, options.sourceId, undefined, {
        sql: '?',
        params: [options.now.toISOString()],
      })
      const rawFacts = sqlite.prepare(`SELECT (${facts.sql}) AS facts`).get(...facts.params) as {
        facts: string
      }
      snapshot.destinationVersion = sha256Hex(rawFacts.facts)
      return snapshot
    })
    .deferred()
