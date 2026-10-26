/** Closed expected boundary refusals; API adapters must classify by type/code, never arbitrary error text. */
export type CsvBrowserPlannerErrorCode =
  | 'snapshot_budget_exceeded'
  | 'adapter_unsupported'
  | 'administrator_required'
  | 'exporter_zone_invalid'
  | 'exporter_zone_required'
  | 'invalid_exclusion'
  | 'mapping_invalid'
  | 'mapping_source_unknown'
  | 'mapping_too_large'
  | 'organization_required'
  | 'plan_row_mismatch'
  | 'preview_rejected'
  | 'row_rejected'
  | 'setup_identity_invalid'
  | 'snapshot_input_mismatch'
  | 'snapshot_selection_mismatch'
  | 'source_identity_mismatch'
export class CsvBrowserPlannerError extends Error {
  constructor(
    readonly code: CsvBrowserPlannerErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options)
    this.name = 'CsvBrowserPlannerError'
  }
}
export const assertCsvExporterZone = (zone: string): void => {
  if (typeof zone !== 'string' || zone.trim() === '')
    throw new CsvBrowserPlannerError('exporter_zone_required')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format()
  } catch (cause) {
    throw new CsvBrowserPlannerError('exporter_zone_invalid', { cause })
  }
}
