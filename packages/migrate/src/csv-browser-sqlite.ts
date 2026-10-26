import { CsvBrowserPlannerError, assertCsvExporterZone } from './csv-browser-errors.js'
/** Concrete Container workspace composition, consumed by staging/apply in #1181/#1183. */
import type BetterSqlite3 from 'better-sqlite3'
import type { CompiledQuery } from '@ezacto/db'
import type { AdministratorActor, CsvBrowserLease } from '@ezacto/core'
import {
  createContainerDatabase,
  createCsvBrowserDatasetLedger,
  createTimesheetLockPolicyRepository,
  DrizzleTrackedResourceRepository,
  registerCsvImportSqliteFunctions,
  csvImportDestinationFence,
  csvImportSetupFacts,
} from '@ezacto/db'
import { parseCsv } from './csv-contract.js'
import { createClockifyBrowserAdapter, CLOCKIFY_ADAPTERS } from './csv-clockify.js'
import { emptyMapping } from './csv-mapping.js'
import type { CsvBrowserMapping } from './csv-browser-mapping.js'
import {
  planCsvImportFromSnapshot,
  csvBrowserSealInput,
  type CsvBrowserPlan,
  type CsvBrowserDestinationSnapshot,
} from './csv-planner.js'
import { readCsvDestinationSnapshot } from './csv-planner-snapshot.js'
import { createCsvBrowserWriter } from './csv-browser-writer.js'

export const createSqliteCsvBrowserService = (
  sqlite: BetterSqlite3.Database,
  options: { now?: () => Date; authorityFence?: (actor: AdministratorActor) => CompiledQuery } = {},
) => {
  const now = options.now ?? (() => new Date())
  registerCsvImportSqliteFunctions(sqlite)
  const database = createContainerDatabase(sqlite)
  const tracked = new DrizzleTrackedResourceRepository(
    database,
    createTimesheetLockPolicyRepository(database),
  )
  const ledger = createCsvBrowserDatasetLedger(database, {
    tracked,
    now,
    destinationFence: csvImportDestinationFence,
    setupFacts: csvImportSetupFacts,
    ...(options.authorityFence === undefined ? {} : { authorityFence: options.authorityFence }),
  })
  return {
    ledger,
    preview(
      actor: AdministratorActor,
      sourceId: string,
      bytes: Uint8Array,
      input: {
        exporterZone: string
        mapping?: CsvBrowserMapping
        excludedLines?: readonly number[]
      },
    ): { plan: CsvBrowserPlan; snapshot: CsvBrowserDestinationSnapshot } {
      assertCsvExporterZone(input.exporterZone)
      const parsed = parseCsv(
        bytes,
        createClockifyBrowserAdapter({ exporterZone: input.exporterZone }),
      )
      const mapping = input.mapping ?? emptyMapping()
      const snapshot = readCsvDestinationSnapshot(sqlite, {
        actor,
        sourceId,
        parsed,
        mapping,
        excludedLines: input.excludedLines,
        now: now(),
      })
      const plan = planCsvImportFromSnapshot(parsed, mapping, snapshot, {
        actor,
        sourceId,
        adapterId: CLOCKIFY_ADAPTERS.browser,
        exporterZone: input.exporterZone,
        ...(input.excludedLines ? { excludedLines: input.excludedLines } : {}),
      })
      return { plan, snapshot }
    },
    confirm(actor: AdministratorActor, plan: CsvBrowserPlan) {
      if (actor.kind !== 'administrator' || actor.userId !== plan.actor.userId)
        throw new CsvBrowserPlannerError('administrator_required')
      if (plan.plan.report.fileErrors.length || plan.rejectedRows)
        throw new CsvBrowserPlannerError('preview_rejected')
      return ledger.seal(actor, csvBrowserSealInput(plan), true)
    },
    writer(snapshot: CsvBrowserDestinationSnapshot, plan: CsvBrowserPlan) {
      return createCsvBrowserWriter(ledger, snapshot, plan)
    },
  }
}
export { readCsvDestinationSnapshot } from './csv-planner-snapshot.js'
export { createCsvBrowserWriter } from './csv-browser-writer.js'
export type { AdministratorActor, CsvBrowserLease }
