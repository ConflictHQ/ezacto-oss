/** Workspace-only portable surface. This does not advertise a deployed browser capability or npm subpath. */
export {
  parseCsv,
  sourceKeys,
  nameKey,
  type ParsedCsv,
  type CsvIssue,
  type CsvRow,
  type CsvAdapter,
} from './csv-contract.js'
export { parseMapping, canonicalMapping, emptyMapping, type CsvMapping } from './csv-mapping.js'
export { CLOCKIFY_ADAPTERS, createClockifyBrowserAdapter } from './csv-clockify.js'
export {
  planCsvImportFromSnapshot,
  csvBrowserSealInput,
  type CsvBrowserPlan,
  type CsvBrowserPlanOptions,
  type CsvBrowserDestinationSnapshot,
} from './csv-planner.js'
export { csvPlanId, csvPlanDifference } from './csv-dataset-contract.js'

export {
  parseBrowserMapping,
  csvSourceEntityKeys,
  type CsvBrowserMapping,
  type CsvBrowserDestinationIds,
} from './csv-browser-mapping.js'

export { CsvBrowserPlannerError, type CsvBrowserPlannerErrorCode } from './csv-browser-errors.js'
