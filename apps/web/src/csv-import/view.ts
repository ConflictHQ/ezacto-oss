import type { ImportPreview, ImportRun } from './contract.js'

export const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  return element
}
const count = (value: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
const seconds = (value: number): string => `${count(value)} seconds`
export const facts = (rows: readonly (readonly [string, string | number])[]): HTMLElement => {
  const list = node('dl'); list.className = 'settings-facts csv-import-facts'
  for (const [label, value] of rows) { const term = node('dt', label), detail = node('dd', typeof value === 'number' ? count(value) : value); list.append(term, detail) }
  return list
}

export const runFacts = (run: ImportRun): HTMLElement => facts([
  ['Run', run.id], ['File SHA-256', run.file_sha256], ['Bytes', run.bytes],
  ['Dataset', run.source_id ?? 'Not registered yet'], ['Staging status', run.status],
])

export const previewFacts = (preview: ImportPreview): HTMLElement => {
  const host = node('div'), { tallies, choices } = preview
  host.append(facts([
    ['Destination organization', preview.organization_name], ['Preview', preview.preview_id],
    ['File SHA-256', preview.run.file_sha256], ['Dataset', choices.source_id],
    ['Workspace identity', choices.workspace_identity], ['Adapter', choices.adapter_id],
    ['Source dates', 'YYYY-MM-DD'], ['Exporter timezone', choices.exporter_zone],
    ['Interpretation', 'Source wall-clock values in the reviewed exporter zone'],
    ['Organization currency', `${tallies.organization_currency} (not a destination price or conversion)`],
    ['Time pricing', 'Unpriced; no source monetary value is imported'],
    ['File rows', tallies.file_rows], ['Selected rows', tallies.selected_rows],
    ['Explicitly excluded physical lines', choices.excluded_lines.length ? choices.excluded_lines.join(', ') : 'None'],
    ['New time rows', tallies.new_rows], ['Already imported rows', tallies.already_imported_rows],
    ['Rejected rows (distinct)', tallies.rejected_row_count], ['Row rejection diagnostics', tallies.diagnostic_count],
    ['File errors', tallies.file_error_count], ['Invalid rows', tallies.invalid_rows], ['Unsupported rows', tallies.unsupported_rows],
    ['Selected source duration', seconds(tallies.source_seconds)], ['Destination duration', seconds(tallies.destination_seconds)],
    ['Destination minus source', seconds(tallies.destination_delta_seconds)], ['Deleted imported history', tallies.deleted_imported_rows],
    ['Ignored columns', tallies.ignored_column_count], ['Ignored column names', tallies.ignored_columns.length ? tallies.ignored_columns.join(', ') : 'See static warning diagnostics'], ['Warnings', tallies.warning_count],
  ]))
  const scroll = node('div'); scroll.className = 'data-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Entity and assignment review')
  const table = node('table'); table.className = 'data-table'; table.append(node('caption', 'Reviewed setup entities'))
  const head = node('thead'), header = node('tr'); for (const text of ['Entity', 'Matched', 'New', 'Rejected']) header.append(node('th', text)); head.append(header); table.append(head)
  const body = node('tbody')
  for (const kind of ['people', 'clients', 'projects', 'tasks'] as const) {
    const row = node('tr'); const label = node('th', kind); label.scope = 'row'; row.append(label)
    for (const key of ['matched', 'new', 'rejected'] as const) row.append(node('td', count(tallies[kind][key])))
    body.append(row)
  }
  table.append(body); scroll.append(table); host.append(scroll, facts([
    ['New person/project assignments', tallies.assignments.user_project], ['New project/task assignments', tallies.assignments.project_task],
  ]), node('p', 'Existing task assignments decide billability. Source billability only seeds new assignments. Review warning diagnostics for overrides.'))
  return host
}
