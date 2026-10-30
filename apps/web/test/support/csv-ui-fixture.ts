import type { ImportPreview } from '../../src/csv-import/contract.js'

export const csvPreview = (): ImportPreview => ({
  organization_name: 'Owned import organization', preview_id: 'preview_' + 'b'.repeat(64),
  run: { id: 'csv_owned', status: 'previewed', version: 2, file_sha256: 'a'.repeat(64), bytes: 4096,
    staging_expires_at: '2026-10-26T12:00:00.000Z', retention_deadline: null, purge_allowed: true,
    allowed_actions: ['map', 'preview', 'purge'], retryable: false, preview_id: 'preview_' + 'b'.repeat(64), preview_stale: false, source_id: 'browser:owned', tallies: null },
  choices: { workspace_identity: 'owned-clockify-workspace', source_id: 'browser:owned', adapter_id: 'clockify-detailed-browser@2', date_format: 'iso', exporter_zone: 'America/Costa_Rica', destination_interpretation: 'source_wall_time', currency_policy: 'destination_rates', excluded_lines: [], mapping: {} },
  tallies: { file_rows: 2, selected_rows: 2, new_rows: 2, already_imported_rows: 0, rejected_row_count: 0, diagnostic_count: 0, file_error_count: 0, invalid_rows: 0, unsupported_rows: 0,
    source_seconds: 7201, destination_seconds: 7200, destination_delta_seconds: -1, deleted_imported_rows: 0, organization_currency: 'EUR', unpriced: true, ignored_columns: [], ignored_column_count: 2, warning_count: 2,
    people: { matched: 0, new: 1, rejected: 0 }, clients: { matched: 1, new: 0, rejected: 0 }, projects: { matched: 0, new: 1, rejected: 0 }, tasks: { matched: 1, new: 0, rejected: 0 }, assignments: { user_project: 1, project_task: 1 } },
})
