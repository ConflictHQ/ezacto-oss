import { EzactoApiError } from '@conflict-hq/ezacto-client'

export class CsvUiError extends Error {}

const messages: Readonly<Record<string, string>> = {
  capability_unsupported: 'Browser CSV import is unavailable on this runtime. Use the operator SQLite import tool.',
  administrator_required: 'A current administrator session is required. Sign in again before continuing.',
  session_required: 'Sign in again before continuing this import.',
  token_denied: 'CSV browser import requires an administrator session, not an API token.',
  csrf_failed: 'The request could not be authorized. Reload this same-origin page and sign in again.',
  run_not_found: 'This import is unavailable to the current administrator.',
  file_too_large: 'The CSV exceeds the supported byte limit. Use the operator import tool for a larger source.',
  too_many_rows: 'The CSV exceeds 50,000 rows. Use the operator import tool for a larger source.',
  too_many_columns: 'The CSV exceeds 40 source columns.',
  field_too_long: 'A source field exceeds the supported length.',
  name_too_long: 'A source name exceeds the supported length.',
  mapping_too_large: 'The mapping exceeds the supported size. Use the operator import tool.',
  not_csv: 'Upload a valid Clockify Detailed CSV, not a workbook or archive.',
  invalid_utf8: 'The CSV must contain valid UTF-8 text.',
  hash_mismatch: 'The uploaded bytes did not match their file hash. Choose the same file and retry.',
  length_mismatch: 'The uploaded byte count did not match. Choose the same file and retry.',
  parse_budget_exceeded: 'The CSV could not be parsed within the supported budget. Use the operator import tool.',
  preview_stale: 'This preview is no longer current. Refresh and review the saved choices before applying.',
  source_choice_required: 'Use this organization’s registered Clockify workspace identity. A different identity cannot bypass its import history.',
  mapping_invalid: 'The mapping or selected physical lines are invalid. Review the choices and diagnostics.',
  upload_aborted: 'Upload stopped. No apply command was sent.',
  run_busy: 'This import is already being processed. Read its authoritative status before sending another command.',
  storage_unavailable: 'Import storage is temporarily unavailable. Refresh authoritative status before trying again.',
}

export const csvFailureCode = (error: unknown): string | null => {
  if (!(error instanceof EzactoApiError)) return null
  const body = error.body as { error?: { code?: unknown } } | null
  return typeof body?.error?.code === 'string' ? body.error.code : null
}
export const authorityRefused = (error: unknown): boolean =>
  error instanceof EzactoApiError && (error.status === 401 || error.status === 403)

/** Never reflect transport errors, uploaded names, paths or raw parse exceptions. */
export const csvFailureMessage = (error: unknown): string => {
  if (error instanceof CsvUiError) return error.message
  const code = csvFailureCode(error)
  return code && Object.hasOwn(messages, code) ? messages[code]! : 'The import request could not be completed. Refresh authoritative status before trying again.'
}
