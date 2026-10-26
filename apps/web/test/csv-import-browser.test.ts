/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { createCsvImportController } from '../src/csv-import/browser.js'
import { renderCsvImportPanel } from '../src/csv-import/render.js'
import type { ImportApi } from '../src/csv-import/contract.js'
import { csvPreview } from './support/csv-ui-fixture.js'
const controllers: ReturnType<typeof createCsvImportController>[] = []
const fixture = () => {
  const preview = csvPreview()
  const api = {
    getCsvImportCapabilities: vi.fn(async () => ({ data: { runtime: 'container', staging_supported: true, browser_ready: true, apply_supported: false, max_csv_bytes: 5242880, max_mapping_bytes: 1048576, raw_retention_hours: 24 } })),
    getCsvImport: vi.fn(async () => ({ data: preview.run })),
    getCsvImportMapping: vi.fn(async () => ({ data: { version: preview.run.version, preview_id: preview.preview_id, choices: preview.choices } })),
    previewCsvImport: vi.fn(async () => ({ data: preview })),
    listCsvImportCatalog: vi.fn(async () => ({ data: { items: [], total: 0, next_cursor: null, preview_id: preview.preview_id } })),
    listCsvImportErrors: vi.fn(async () => ({ data: { items: [], total: 0, next_cursor: null, preview_id: preview.preview_id } })),
    uploadCsvImport: vi.fn(async () => ({ data: preview.run })), mapCsvImport: vi.fn(async () => ({ data: preview.run })), downloadCsvImportDiagnostics: vi.fn(), purgeCsvImportInput: vi.fn(async () => undefined),
  }
  return { api, preview }
}
const mount = (api: ReturnType<typeof fixture>['api'], restored = true) => {
  history.replaceState(null, '', `/settings/company${restored ? '?csv_import=csv_owned' : ''}#import-export`)
  document.body.innerHTML = renderCsvImportPanel()
  const controller = createCsvImportController(document.querySelector('[data-csv-import]')!, api as unknown as ImportApi), session = new AbortController()
  controllers.push(controller)
  return { controller, session, activate: () => controller.activate({ actor: 'admin:session', administrator: true, signal: session.signal }) }
}
const find = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
afterEach(() => { for (const controller of controllers.splice(0)) controller.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); history.replaceState(null, '', '/') })

describe('CSV staging-only browser controller', () => {
  it('refuses unsupported runtimes before reading a private locator', async () => {
    const { api } = fixture(); api.getCsvImportCapabilities.mockResolvedValue({ data: { runtime: 'worker', staging_supported: false, browser_ready: false, apply_supported: false } } as never)
    await mount(api).activate()
    expect(api.getCsvImport).not.toHaveBeenCalled(); expect(find<HTMLElement>('[data-csv-private]').hidden).toBe(true)
  })
  it('refuses nonadministrators before any capability request', async () => {
    const { api } = fixture(), { controller, session } = mount(api)
    await controller.activate({ actor: 'member', administrator: false, signal: session.signal })
    expect(api.getCsvImportCapabilities).not.toHaveBeenCalled()
  })
  it('shows processing and blocks unload until the request settles', async () => {
    const { api } = fixture(); let resolve!: (value: Awaited<ReturnType<typeof api.getCsvImportCapabilities>>) => void
    api.getCsvImportCapabilities.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const { activate } = mount(api, false), pending = activate()
    expect(find<HTMLElement>('[data-csv-status]').hasAttribute('data-request-busy')).toBe(true)
    const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(true)
    resolve({ data: { runtime: 'container', staging_supported: true, browser_ready: true, apply_supported: false, max_csv_bytes: 5242880, max_mapping_bytes: 1048576, raw_retention_hours: 24 } }); await pending
    expect(find<HTMLElement>('[data-csv-status]').hasAttribute('data-request-busy')).toBe(false)
    expect(find<HTMLButtonElement>('[data-csv-apply]').disabled).toBe(true)
  })
  it('discards a late private preview after session abort', async () => {
    const { api } = fixture(); let resolve!: (value: Awaited<ReturnType<typeof api.previewCsvImport>>) => void
    api.previewCsvImport.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const { activate, session } = mount(api), pending = activate()
    await vi.waitFor(() => expect(api.previewCsvImport).toHaveBeenCalled())
    session.abort(); resolve({ data: csvPreview() }); await pending
    expect(document.body.textContent).not.toContain('Owned import organization'); expect(find<HTMLInputElement>('[name="workspace"]').value).toBe(''); expect(location.search).toBe('')
  })
  it('renders a saved immutable preview while keeping apply unavailable', async () => {
    const { api } = fixture(); await mount(api).activate()
    expect(document.body.textContent).toContain('Owned import organization')
    expect(find<HTMLButtonElement>('[data-csv-apply]').disabled).toBe(true)
    const workspace = find<HTMLInputElement>('[name="workspace"]'); workspace.value = 'different'; workspace.dispatchEvent(new Event('input'))
    expect(find<HTMLElement>('[data-csv-confirm-state]').textContent).toContain('Choices changed')
    expect(api.mapCsvImport).not.toHaveBeenCalled()
  })
  it('clears private state on authority refusal without reflecting server text', async () => {
    const { api } = fixture(); await mount(api).activate()
    api.getCsvImport.mockRejectedValueOnce(new EzactoApiError(403, { error: { code: 'forbidden', message: 'private raw source' } }, null))
    find<HTMLButtonElement>('[data-csv-reload]').click()
    await vi.waitFor(() => expect(find<HTMLElement>('[data-csv-private]').hidden).toBe(true))
    expect(document.body.textContent).not.toContain('private raw source'); expect(document.body.textContent).not.toContain('Owned import organization')
  })
  it('retains purge retry on deletion failure and enables another upload after success', async () => {
    const { api } = fixture(); await mount(api).activate()
    api.purgeCsvImportInput.mockRejectedValueOnce(new Error('private path'))
    find<HTMLButtonElement>('[data-csv-purge]').click()
    await vi.waitFor(() => expect(find<HTMLButtonElement>('[data-csv-purge]').disabled).toBe(false))
    expect(find<HTMLButtonElement>('[data-csv-purge]').hidden).toBe(false)
    find<HTMLButtonElement>('[data-csv-purge]').click()
    await vi.waitFor(() => expect(find<HTMLElement>('[data-csv-status]').textContent).toContain('diagnostics purged'))
    expect(find<HTMLInputElement>('[name="file"]').disabled).toBe(false)
  })
})
