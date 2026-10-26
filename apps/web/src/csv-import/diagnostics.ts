import { setRequestBusy } from '../request-feedback.js'
import type { ImportDiagnostic, ImportPreview, ImportStagingApi } from './contract.js'
import { CsvUiError, csvFailureMessage } from './errors.js'
import { node } from './view.js'

export interface DiagnosticsContext {
  readonly preview: ImportPreview
  readonly signal: AbortSignal
  isCurrent(): boolean
  canEdit(): boolean
  excludedLines(): readonly number[] | null
  exclude(line: number, value: boolean): void
  failure(error: unknown): void
}

/** Diagnostics are server-defined static messages; cells never become HTML or log text. */
export const createCsvDiagnostics = (root: HTMLElement, api: ImportStagingApi) => {
  const host = root.querySelector<HTMLElement>('[data-csv-errors]')!
  const status = root.querySelector<HTMLElement>('[data-csv-errors-status]')!
  const filter = root.querySelector<HTMLSelectElement>('[data-csv-error-kind]')!
  const more = root.querySelector<HTMLButtonElement>('[data-csv-errors-more]')!
  let context: DiagnosticsContext | null = null, revision = 0, busy = false
  let cursor: string | null = null, rows: ImportDiagnostic[] = []
  const seen = new Set<string>()
  const current = (active: DiagnosticsContext, request: number) => context === active && revision === request && active.isCurrent() && !active.signal.aborted
  const syncSelection = () => {
    const active = context
    if (!active || !active.isCurrent() || active.signal.aborted) return
    const selected = active.excludedLines()
    for (const input of host.querySelectorAll<HTMLInputElement>('[data-csv-diagnostic-line]')) {
      input.checked = selected?.includes(Number(input.dataset.csvDiagnosticLine)) ?? false
      input.disabled = selected === null || !active.canEdit()
    }
  }
  const paint = (active: DiagnosticsContext) => {
    const table = node('table'); table.className = 'data-table'
    table.append(node('caption', 'Static import diagnostics'))
    const head = node('thead'), labels = node('tr')
    for (const label of ['Physical line', 'Category', 'Code', 'Explanation', 'Selection']) { const th = node('th', label); th.scope = 'col'; labels.append(th) }
    head.append(labels); table.append(head)
    const body = node('tbody')
    for (const diagnostic of rows) {
      const row = node('tr')
      for (const text of [diagnostic.scope === 'file' ? `File${diagnostic.line ? ` · ${diagnostic.line}` : ''}` : String(diagnostic.line), diagnostic.kind, diagnostic.code, diagnostic.message]) row.append(node('td', text))
      const selection = node('td')
      if (diagnostic.scope === 'row' && diagnostic.excludable && diagnostic.line >= 2) {
        const label = node('label', `Exclude physical line ${diagnostic.line}`), checkbox = node('input')
        label.className = 'settings-toggle'
        checkbox.type = 'checkbox'; checkbox.dataset.csvDiagnosticLine = String(diagnostic.line)
        checkbox.addEventListener('change', () => {
          if (context !== active || !active.isCurrent() || active.signal.aborted) return
          if (active.canEdit() && active.excludedLines() !== null) active.exclude(diagnostic.line, checkbox.checked)
          syncSelection()
        })
        label.prepend(checkbox); selection.append(label)
      } else selection.textContent = diagnostic.scope === 'file' ? 'File error cannot be excluded' : 'Review warning'
      row.append(selection); body.append(row)
    }
    table.append(body)
    const scroll = node('div'); scroll.className = 'data-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Import diagnostics; scroll to see all columns'); scroll.append(table)
    host.replaceChildren(rows.length ? scroll : node('p', 'No diagnostics in this category.'))
    syncSelection()
  }
  const load = async (append: boolean) => {
    const active = context, request = revision
    if (!active || busy || !current(active, request)) return
    const next = append ? cursor : null
    if (append && next === null) return
    busy = true; setRequestBusy(status, true); more.disabled = true; status.textContent = 'Reading diagnostics…'
    try {
      if (next && seen.has(next)) throw new CsvUiError('The diagnostics repeated a page. Refresh the preview.')
      const kind = filter.value
      const page = (await api.listCsvImportErrors({ runId: active.preview.run.id, query: { preview_id: active.preview.preview_id, per_page: 50, ...(next ? { cursor: next } : {}), ...(kind === 'invalid' || kind === 'unsupported' || kind === 'warning' ? { kind } : {}) }, signal: active.signal })).data
      if (!current(active, request)) return
      if (page.preview_id !== active.preview.preview_id) throw new CsvUiError('The diagnostic preview changed. Refresh it before continuing.')
      if (!append) { rows = []; seen.clear() }
      if (next) seen.add(next)
      rows.push(...page.items); cursor = page.next_cursor; paint(active); more.hidden = cursor === null
      status.textContent = `${rows.length} of ${page.total} diagnostics shown. ${active.preview.tallies.rejected_row_count} distinct rows remain rejected; multiple diagnostics may refer to one row.`
    } catch (error) { if (current(active, request)) { status.textContent = csvFailureMessage(error); active.failure(error) } }
    finally { if (current(active, request)) { busy = false; setRequestBusy(status, false); more.disabled = false } }
  }
  filter.addEventListener('change', () => { revision++; busy = false; rows = []; cursor = null; host.replaceChildren(); more.hidden = true; void load(false) })
  more.addEventListener('click', () => void load(true))
  return {
    syncSelection,
    async activate(active: DiagnosticsContext) { context = active; revision++; busy = false; rows = []; cursor = null; seen.clear(); await load(false) },
    clear() { context = null; revision++; busy = false; cursor = null; rows = []; seen.clear(); host.replaceChildren(); status.textContent = ''; setRequestBusy(status, false); filter.value = 'all'; more.hidden = true },
  }
}
