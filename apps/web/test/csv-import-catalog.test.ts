/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCsvCatalog } from '../src/csv-import/catalog.js'
import { createCsvDiagnostics } from '../src/csv-import/diagnostics.js'
import { renderCsvImportPanel } from '../src/csv-import/render.js'
import type { DestinationCandidate, ImportDiagnostic, ImportMapping, ImportStagingApi, SourceEntity } from '../src/csv-import/contract.js'
import { csvPreview } from './support/csv-ui-fixture.js'

const source = (): SourceEntity => ({ kind: 'projects', source_key: 'project_opaque', label: '<svg onload=alert(1)>Source', parent_source_key: 'client_opaque', parents: [{ kind: 'clients', source_key: 'client_opaque', label: 'Parent / Private' }], state: 'rejected', selected_id: null, selected_destination: null, ambiguous: true })
const candidate = (id: number): DestinationCandidate => ({ id, name: 'Same name', parent_id: id, parent_name: `Exact parent ${id}`, is_active: true, selectable: true, currency: id === 7 ? 'EUR' : 'JPY' })
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('parent-scoped CSV mapping and physical diagnostics', () => {
  it('loads exact parent/currency choices lazily and writes only the selected opaque source ID', async () => {
    document.body.innerHTML = renderCsvImportPanel()
    const preview = csvPreview(), row = source(), edit = vi.fn(), failure = vi.fn()
    let mapping: ImportMapping['mapping'] = {}
    const read = vi.fn(async (args: { query: { source_key?: string; cursor?: string } }) => ({ data: args.query.source_key
      ? { items: args.query.cursor ? [candidate(8)] : [candidate(7)], total: 2, next_cursor: args.query.cursor ? null : 'opaque_next', preview_id: preview.preview_id }
      : { items: [row], total: 1, next_cursor: null, preview_id: preview.preview_id } }))
    const root = document.querySelector<HTMLElement>('[data-csv-import]')!
    const catalog = createCsvCatalog(root, { listCsvImportCatalog: read } as unknown as ImportStagingApi)
    await catalog.activate({ preview, signal: new AbortController().signal, isCurrent: () => true, canEdit: () => true, mapping: () => mapping, edit: value => { mapping = value; edit(value) }, failure })
    expect(read).toHaveBeenCalledTimes(1); expect(document.querySelector('svg')).toBeNull()
    expect(root.textContent).toContain('Parent / Private'); expect(root.textContent).toContain('ambiguous')
    const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')]
    buttons().find(button => button.textContent === 'Edit this mapping')!.click()
    const action = root.querySelector<HTMLSelectElement>('[data-csv-source-key] form select')!; action.value = 'existing'; action.dispatchEvent(new Event('change'))
    buttons().find(button => button.textContent === 'Load destination choices')!.click()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(root.textContent).toContain('EUR (unpriced)'))
    buttons().find(button => button.textContent === 'Load more destination choices')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('JPY (unpriced)'))
    expect(root.textContent).toContain('Same name (#7)'); expect(root.textContent).toContain('Same name (#8)')
    const selects = root.querySelectorAll<HTMLSelectElement>('[data-csv-source-key] form select'); selects[1]!.value = '8'
    root.querySelector<HTMLFormElement>('[data-csv-source-key] form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(edit).toHaveBeenLastCalledWith({ destinationIds: { projects: { project_opaque: 8 } } })
    expect(failure).not.toHaveBeenCalled()
    catalog.clear(); expect(root.textContent).not.toContain('Parent / Private'); expect(root.textContent).not.toContain('Exact parent')
  })
  it('blocks synthetic mapping submissions while the parent reports a pending command', async () => {
    document.body.innerHTML = renderCsvImportPanel()
    const preview = csvPreview(), edit = vi.fn(), root = document.querySelector<HTMLElement>('[data-csv-import]')!
    const catalog = createCsvCatalog(root, { listCsvImportCatalog: async () => ({ data: { items: [source()], total: 1, next_cursor: null, preview_id: preview.preview_id } }) } as unknown as ImportStagingApi)
    await catalog.activate({ preview, signal: new AbortController().signal, isCurrent: () => true, canEdit: () => false, mapping: () => ({}), edit, failure: vi.fn() })
    root.querySelector<HTMLFormElement>('[data-csv-source-key] form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(edit).not.toHaveBeenCalled()
  })
  it('shows the reviewed new inactive person name as text on the immutable source card', async () => {
    document.body.innerHTML = renderCsvImportPanel()
    const preview = csvPreview(), row: SourceEntity = { ...source(), kind: 'people', source_key: 'person_opaque', label: 'new@example.invalid', parents: [], parent_source_key: null, state: 'new', ambiguous: false }
    const root = document.querySelector<HTMLElement>('[data-csv-import]')!
    const catalog = createCsvCatalog(root, { listCsvImportCatalog: async () => ({ data: { items: [row], total: 1, next_cursor: null, preview_id: preview.preview_id } }) } as unknown as ImportStagingApi)
    await catalog.activate({ preview, signal: new AbortController().signal, isCurrent: () => true, canEdit: () => true, mapping: () => ({ people: { 'new@example.invalid': { create: { firstName: '<img src=x>', lastName: 'Inactive' } } } }), edit: vi.fn(), failure: vi.fn() })
    expect(root.textContent).toContain('Proposed inactive person: <img src=x> Inactive. No invitation or password.')
    expect(root.querySelector('img')).toBeNull()
  })
  it('renders all static diagnostic categories with distinct row counts, and file errors have no exclusion control', async () => {
    document.body.innerHTML = renderCsvImportPanel()
    const preview = csvPreview(); preview.tallies.rejected_row_count = 1
    const issues: ImportDiagnostic[] = [
      { line: 1, scope: 'file', excludable: false, kind: 'invalid', code: 'bad_header', message: 'Review the header.' },
      { line: 4, scope: 'row', excludable: true, kind: 'invalid', code: 'bad_date', message: 'Use ISO dates.' },
      { line: 4, scope: 'row', excludable: true, kind: 'unsupported', code: 'locked_date', message: 'The date is locked.' },
      { line: 5, scope: 'row', excludable: false, kind: 'warning', code: 'ignored_money', message: '<b>Ignored monetary input</b>' },
    ]
    const root = document.querySelector<HTMLElement>('[data-csv-import]')!, exclude = vi.fn()
    const diagnostics = createCsvDiagnostics(root, { listCsvImportErrors: async () => ({ data: { items: issues, total: 4, next_cursor: null, preview_id: preview.preview_id } }) } as unknown as ImportStagingApi)
    await diagnostics.activate({ preview, signal: new AbortController().signal, isCurrent: () => true, canEdit: () => true, excludedLines: () => preview.choices.excluded_lines, exclude, failure: vi.fn() })
    expect(root.querySelector('b')).toBeNull(); expect(root.textContent).toContain('4 of 4 diagnostics'); expect(root.textContent).toContain('1 distinct rows')
    expect(root.querySelectorAll('[data-csv-errors] input')).toHaveLength(2)
    const checkbox = root.querySelector<HTMLInputElement>('[data-csv-errors] input')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'))
    expect(exclude).toHaveBeenCalledWith(4, true)
    diagnostics.clear(); expect(root.textContent).not.toContain('Ignored monetary input'); expect(root.querySelectorAll('[data-csv-errors] input')).toHaveLength(0)
  })
  it('retains draft physical-line selections across diagnostic pages and synchronizes duplicate issues', async () => {
    document.body.innerHTML = renderCsvImportPanel()
    const preview = csvPreview(), root = document.querySelector<HTMLElement>('[data-csv-import]')!
    let selected: number[] = []
    const read = vi.fn(async (args: { query?: { cursor?: string } }) => ({ data: {
      items: [{ line: 4, scope: 'row', excludable: true, kind: args.query?.cursor ? 'unsupported' : 'invalid', code: args.query?.cursor ? 'locked_date' : 'invalid_duration', message: 'Review this row.' }],
      total: 2, next_cursor: args.query?.cursor ? null : 'physical_line_page_2', preview_id: preview.preview_id,
    } }))
    const diagnostics = createCsvDiagnostics(root, { listCsvImportErrors: read } as unknown as ImportStagingApi)
    await diagnostics.activate({ preview, signal: new AbortController().signal, isCurrent: () => true, canEdit: () => true, excludedLines: () => selected,
      exclude: (line, value) => { selected = value ? [line] : [] }, failure: vi.fn() })
    const first = root.querySelector<HTMLInputElement>('[data-csv-errors] input')!; first.checked = true; first.dispatchEvent(new Event('change'))
    expect(selected).toEqual([4]); expect(preview.choices.excluded_lines).toEqual([])
    root.querySelector<HTMLButtonElement>('[data-csv-errors-more]')!.click()
    await vi.waitFor(() => expect(root.querySelectorAll('[data-csv-errors] input')).toHaveLength(2))
    expect([...root.querySelectorAll<HTMLInputElement>('[data-csv-errors] input')].every(input => input.checked)).toBe(true)
    const second = root.querySelectorAll<HTMLInputElement>('[data-csv-errors] input')[1]!; second.checked = false; second.dispatchEvent(new Event('change'))
    expect(selected).toEqual([])
    expect([...root.querySelectorAll<HTMLInputElement>('[data-csv-errors] input')].every(input => !input.checked)).toBe(true)
    expect(read.mock.calls[1]![0].query?.cursor).toBe('physical_line_page_2')
  })
})
