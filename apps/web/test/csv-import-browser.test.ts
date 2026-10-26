/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { createCsvImportController } from '../src/csv-import/browser.js'
import { renderCsvImportPanel } from '../src/csv-import/render.js'
import type { ApplyCommand, ApplyStatus, ImportApi } from '../src/csv-import/contract.js'
import { csvPreview } from './support/csv-ui-fixture.js'

const controllers: ReturnType<typeof createCsvImportController>[] = []
const noCommand = (): ApplyStatus => ({ stage_id: 'csv_owned', preview_id: null, state: 'not_confirmed', code: null, command_id: null, command_known: false, pending_command: null,
  file_rows: 2, selected_rows: 2, excluded_rows: 0, committed_rows: 0, inserted_rows: 0, already_imported_rows: 0, created_setup: 0,
  source_seconds_total: 7201, source_seconds_committed: 0, destination_seconds: 0, destination_delta_seconds: 0, deleted_imported_rows: 0, retention_deadline: null, retryable: false, allowed_actions: ['apply', 'inspect', 'purge'] })
const fixture = () => {
  const preview = csvPreview()
  const api = {
    getCsvImportCapabilities: vi.fn(async () => ({ data: { runtime: 'container', staging_supported: true, browser_ready: true, apply_supported: true, max_csv_bytes: 5242880, max_mapping_bytes: 100000, raw_retention_hours: 24 } })),
    getCsvImport: vi.fn(async () => ({ data: preview.run })),
    getCsvImportMapping: vi.fn(async () => ({ data: { version: preview.run.version, preview_id: preview.preview_id, choices: preview.choices } })),
    previewCsvImport: vi.fn(async () => ({ data: preview })),
    listCsvImportCatalog: vi.fn(async () => ({ data: { items: [], total: 0, next_cursor: null, preview_id: preview.preview_id } })),
    listCsvImportErrors: vi.fn(async () => ({ data: { items: [], total: 0, next_cursor: null, preview_id: preview.preview_id } })),
    getCsvImportApply: vi.fn(async () => ({ data: noCommand() })),
    applyCsvImport: vi.fn(async (args: { body: unknown }) => ({ data: { ...noCommand(), command_id: (args.body as ApplyCommand).command_id, state: 'completed' as const, command_known: true, committed_rows: 2, inserted_rows: 2, allowed_actions: ['inspect', 'purge'] as const } })),
    resumeCsvImport: vi.fn(async (args: { body: unknown }) => ({ data: { ...noCommand(), command_id: (args.body as ApplyCommand).command_id, command_known: true, state: 'completed' as const } })),
    uploadCsvImport: vi.fn(), mapCsvImport: vi.fn(async () => ({ data: preview.run })), downloadCsvImportDiagnostics: vi.fn(), purgeCsvImportInput: vi.fn(async () => undefined), cancelCsvImport: vi.fn(async () => ({ data: noCommand() })),
  }
  return { api, preview }
}
const mount = (api: ReturnType<typeof fixture>['api'], restored = true) => {
  history.replaceState(null, '', `/settings/company${restored ? '?csv_import=csv_owned' : ''}#import-export`)
  document.body.innerHTML = renderCsvImportPanel()
  const controller = createCsvImportController(document.querySelector('[data-csv-import]')!, api as unknown as ImportApi)
  controllers.push(controller)
  const session = new AbortController()
  return { controller, session, activate: () => controller.activate({ actor: 'admin:2:current-session', administrator: true, signal: session.signal }) }
}
const find = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const acknowledge = () => { for (const name of ['reviewed', 'difference', 'people']) { const input = find<HTMLInputElement>(`[name="${name}"]`); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })) } }
afterEach(() => { for (const controller of controllers.splice(0)) controller.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); vi.useRealTimers() })

describe('real SDK-shaped Clockify browser controller', () => {
  it('announces pending requests and warns before leaving while processing', async () => {
    const { api } = fixture(); let resolve!: (value: Awaited<ReturnType<typeof api.getCsvImportCapabilities>>) => void
    api.getCsvImportCapabilities.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const { activate } = mount(api, false), pending = activate()
    expect(find<HTMLElement>('[data-csv-status]').hasAttribute('data-request-busy')).toBe(true)
    const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(true)
    resolve({ data: { runtime: 'container', staging_supported: true, browser_ready: true, apply_supported: true, max_csv_bytes: 5242880, max_mapping_bytes: 100000, raw_retention_hours: 24 } }); await pending
    expect(find<HTMLElement>('[data-csv-status]').hasAttribute('data-request-busy')).toBe(false)
  })
  it('checks Container readiness before any private request and never probes a Worker run locator', async () => {
    const { api } = fixture(); api.getCsvImportCapabilities.mockResolvedValue({ data: { runtime: 'worker', staging_supported: false, browser_ready: false, apply_supported: false, max_csv_bytes: 5242880, max_mapping_bytes: 100000, raw_retention_hours: 24 } } as never)
    const { activate } = mount(api); await activate()
    expect(api.getCsvImport).not.toHaveBeenCalled(); expect(api.getCsvImportMapping).not.toHaveBeenCalled()
    expect(find<HTMLElement>('[data-csv-private]').hidden).toBe(true)
    expect(document.body.textContent).toContain('unavailable on this runtime')
  })
  it('uses the same reviewed workflow for an explicitly configured Worker', async () => {
    const {api}=fixture()
    api.getCsvImportCapabilities.mockResolvedValue({data:{runtime:'worker',staging_supported:true,browser_ready:true,apply_supported:true,max_csv_bytes:5242880,max_mapping_bytes:100000,raw_retention_hours:24}} as never)
    await mount(api).activate()
    expect(api.getCsvImport).toHaveBeenCalledOnce()
    expect(find<HTMLElement>('[data-csv-private]').hidden).toBe(false)
  })
  it('requires a fresh policy review before sending a paused Worker resume', async () => {
    const {api,preview}=fixture()
    api.getCsvImport.mockResolvedValueOnce({data:{...preview.run,preview_stale:true}})
    api.getCsvImportApply.mockResolvedValue({data:{...noCommand(),state:'paused',code:'policy_changed',command_known:true,allowed_actions:['inspect','resume','cancel']}} as never)
    await mount(api).activate()
    const resume=find<HTMLButtonElement>('[data-csv-resume]')
    expect(resume.textContent).toBe('Refresh and review paused input')
    resume.click()
    await vi.waitFor(()=>expect(api.mapCsvImport).toHaveBeenCalledOnce())
    await vi.waitFor(()=>expect(api.previewCsvImport).toHaveBeenCalledOnce())
    expect(api.resumeCsvImport).not.toHaveBeenCalled()
    await vi.waitFor(()=>expect(document.body.textContent).toContain('Refreshed preview ready'))
    acknowledge()
    resume.click()
    await vi.waitFor(()=>expect(api.resumeCsvImport).toHaveBeenCalledOnce())
  })
  it('does not even discover a private import under a nonadministrator session', async () => {
    const { api } = fixture(), { controller, session } = mount(api)
    await controller.activate({ actor: 'manager:3', administrator: false, signal: session.signal })
    expect(api.getCsvImportCapabilities).not.toHaveBeenCalled(); expect(api.getCsvImport).not.toHaveBeenCalled()
  })
  it('renders private organization and source values as text, then wipes them and every choice on abort', async () => {
    const { api, preview } = fixture(); preview.organization_name = '<img src=x onerror=alert(1)>Owned private'; preview.choices.workspace_identity = 'private workspace'
    const { activate, session } = mount(api); await activate()
    expect(document.querySelector('img')).toBeNull(); expect(document.body.textContent).toContain(preview.organization_name)
    expect(find<HTMLInputElement>('[name="workspace"]').value).toBe('private workspace')
    session.abort()
    expect(document.body.textContent).not.toContain('Owned private'); expect(find<HTMLInputElement>('[name="workspace"]').value).toBe('')
    expect(document.querySelector('[data-csv-catalog]')!.childElementCount).toBe(0); expect(location.search).toBe('')
  })
  it('preserves an incoming bookmark during activation but removes it on the parent’s explicit clear before abort', async () => {
    const { api } = fixture(), { activate, controller, session } = mount(api); await activate()
    expect(location.search).toBe('?csv_import=csv_owned'); expect(api.getCsvImport).toHaveBeenCalled()
    controller.clear()
    expect(session.signal.aborted).toBe(false)
    expect(location.search).toBe(''); expect(document.body.textContent).not.toContain('Owned import organization')
    expect(find<HTMLInputElement>('[name="workspace"]').value).toBe('')
  })
  it('ignores a late preview across activation with the same AbortSignal', async () => {
    const { api } = fixture(); let resolve!: (value: Awaited<ReturnType<typeof api.previewCsvImport>>) => void
    api.previewCsvImport.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const { controller, activate, session } = mount(api); const first = activate()
    await vi.waitFor(() => expect(api.previewCsvImport).toHaveBeenCalled())
    controller.clear(); await controller.activate({ actor: 'readonly', administrator: false, signal: session.signal })
    resolve({ data: csvPreview() }); await first
    expect(document.body.textContent).not.toContain('Owned import organization'); expect(find<HTMLElement>('[data-csv-private]').hidden).toBe(true)
  })
  it('never applies a dirty review or an unresolved rejection, including synthetic submit', async () => {
    const { api, preview } = fixture(); preview.tallies.rejected_row_count = 1
    const { activate } = mount(api); await activate(); acknowledge()
    find<HTMLFormElement>('[data-csv-confirm-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(find<HTMLElement>('[data-csv-status]').textContent).toContain('Resolve or explicitly exclude'))
    expect(api.applyCsvImport).not.toHaveBeenCalled()
  })
  it('keeps the exact original command for an unknown response and reconciles instead of minting a new UUID', async () => {
    const { api } = fixture(); api.applyCsvImport.mockRejectedValue(new Error('https://secret.example/?token=private'))
    api.getCsvImportApply.mockResolvedValueOnce({ data: noCommand() }).mockRejectedValue(new Error('private transport'))
    const { activate } = mount(api); await activate(); acknowledge()
    find<HTMLFormElement>('[data-csv-confirm-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.applyCsvImport).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(find<HTMLButtonElement>('[data-csv-retry-command]').disabled).toBe(false))
    expect(find<HTMLInputElement>('[name="workspace"]').disabled).toBe(true)
    expect(find<HTMLInputElement>('[name="lines"]').disabled).toBe(true)
    find<HTMLFormElement>('[data-csv-source-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(api.mapCsvImport).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(find<HTMLButtonElement>('[data-csv-retry-command]').disabled).toBe(false))
    find<HTMLButtonElement>('[data-csv-retry-command]').click()
    await vi.waitFor(() => expect(api.applyCsvImport).toHaveBeenCalledTimes(2))
    expect(api.applyCsvImport.mock.calls[1]![0].body).toEqual(api.applyCsvImport.mock.calls[0]![0].body)
    expect(document.body.textContent).not.toContain('secret.example'); expect(document.body.textContent).not.toContain('private transport')
  })
  it('clears private preview and choices after a fresh authority refusal', async () => {
    const { api } = fixture(), { activate } = mount(api); await activate()
    api.getCsvImport.mockRejectedValueOnce(new EzactoApiError(403, { error: { code: 'forbidden', message: 'private server detail' } }, null))
    find<HTMLButtonElement>('[data-csv-reload]').click()
    await vi.waitFor(() => expect(find<HTMLElement>('[data-csv-private]').hidden).toBe(true))
    expect(document.body.textContent).not.toContain('Owned import organization'); expect(find<HTMLInputElement>('[name="workspace"]').value).toBe('')
    expect(document.body.textContent).not.toContain('private server detail')
  })
  it('keeps authoritative progress and Stop when raw input expires before its sweep changes the stage', async () => {
    const { api, preview } = fixture(); preview.run.status = 'confirmed'; preview.run.preview_stale = true
    api.getCsvImportMapping.mockRejectedValueOnce(new EzactoApiError(409, { error: { code: 'preview_stale', message: 'private expired input' } }, null))
    api.getCsvImportApply.mockResolvedValue({ data: { ...noCommand(), state: 'paused', code: 'input_expired', command_known: true, committed_rows: 1, allowed_actions: ['inspect', 'cancel'] } } as never)
    const { activate } = mount(api); await activate()
    expect(api.getCsvImportApply.mock.invocationCallOrder[0]).toBeLessThan(api.getCsvImportMapping.mock.invocationCallOrder[0]!)
    expect(find<HTMLElement>('[data-csv-progress]').hidden).toBe(false); expect(find<HTMLButtonElement>('[data-csv-cancel]').hidden).toBe(false)
    expect(document.body.textContent).toContain('Authoritative progress and Stop remain available')
    expect(find<HTMLInputElement>('[name="workspace"]').value).toBe(''); expect(api.previewCsvImport).not.toHaveBeenCalled()
    expect(find<HTMLFormElement>('[data-csv-upload-form]').hidden).toBe(false)
    expect(find<HTMLFormElement>('[data-csv-source-form]').hidden).toBe(true)
  })
  it('does not trap a definitely refused 422 packet as unknown after authoritative absence is established', async () => {
    const { api } = fixture(), { activate } = mount(api); await activate(); acknowledge()
    api.applyCsvImport.mockRejectedValueOnce(new EzactoApiError(422, { error: { code: 'binding_mismatch', message: 'private refusal' } }, null))
    find<HTMLFormElement>('[data-csv-confirm-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(find<HTMLElement>('[data-csv-status]').textContent).toContain('This command was refused'))
    expect(find<HTMLButtonElement>('[data-csv-retry-command]').hidden).toBe(true)
    expect(find<HTMLButtonElement>('[data-csv-apply]').disabled).toBe(true)
    expect(find<HTMLButtonElement>('[data-csv-reload]').disabled).toBe(false)
    expect(document.body.textContent).not.toContain('private refusal')
  })
  it('retains an accepted exact packet even when the server returns a later 409 refusal', async () => {
    const { api } = fixture(), { activate } = mount(api); await activate(); acknowledge()
    api.applyCsvImport.mockRejectedValue(new EzactoApiError(409, { error: { code: 'binding_mismatch', message: 'safe static refusal' } }, null))
    api.getCsvImportApply.mockImplementation(async () => ({ data: { ...noCommand(), pending_command: api.applyCsvImport.mock.calls[0]![0].body as ApplyCommand } }))
    find<HTMLFormElement>('[data-csv-confirm-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(find<HTMLElement>('[data-csv-status]').textContent).toContain('accepted confirmation still exists'))
    expect(find<HTMLButtonElement>('[data-csv-retry-command]').hidden).toBe(false)
    expect(find<HTMLButtonElement>('[data-csv-apply]').disabled).toBe(true)
  })
  it('recovers the exact accepted packet from the server after reload without browser command storage', async () => {
    const { api, preview } = fixture()
    const packet: ApplyCommand = { preview_id: preview.preview_id, command_id: '00000000-0000-4000-8000-000000000009', version: 2, expected_selected_rows: 2, expected_source_seconds: 7201, expected_destination_seconds: 7200, acknowledge_exclusions: false, acknowledge_destination_difference: true, acknowledge_new_people: true }
    api.getCsvImportApply.mockResolvedValue({ data: { ...noCommand(), pending_command: packet } })
    const { activate } = mount(api); await activate()
    expect(find<HTMLButtonElement>('[data-csv-retry-command]').hidden).toBe(false)
    find<HTMLButtonElement>('[data-csv-retry-command]').click()
    await vi.waitFor(() => expect(api.applyCsvImport).toHaveBeenCalledTimes(1))
    expect(api.applyCsvImport.mock.calls[0]![0].body).toEqual(packet)
    expect(location.search).toBe('?csv_import=csv_owned')
    expect(location.href).not.toContain(packet.command_id)
  })
  it('uses the fresh owned stage version for explicit Resume while preserving immutable counts and preview', async () => {
    const { api, preview } = fixture()
    api.getCsvImportApply.mockResolvedValue({ data: { ...noCommand(), state: 'paused', command_known: true, allowed_actions: ['inspect', 'resume', 'cancel'] } } as never)
    const { activate } = mount(api); await activate(); acknowledge()
    api.getCsvImport.mockResolvedValueOnce({ data: { ...preview.run, version: 9 } })
    find<HTMLButtonElement>('[data-csv-resume]').click()
    await vi.waitFor(() => expect(api.resumeCsvImport).toHaveBeenCalledTimes(1))
    expect(api.resumeCsvImport.mock.calls[0]![0].body).toMatchObject({ version: 9, preview_id: preview.preview_id, expected_selected_rows: 2, expected_source_seconds: 7201, expected_destination_seconds: 7200 })
    expect(preview.run.version).toBe(2)
    expect(api.applyCsvImport).not.toHaveBeenCalled()
  })
  it('never replaces an uncertain new Resume packet with the server’s older accepted command', async () => {
    const { api, preview } = fixture()
    const oldPacket: ApplyCommand = { preview_id: preview.preview_id, command_id: '00000000-0000-4000-8000-000000000009', version: 2, expected_selected_rows: 2, expected_source_seconds: 7201, expected_destination_seconds: 7200, acknowledge_exclusions: false, acknowledge_destination_difference: true, acknowledge_new_people: true }
    api.getCsvImportApply.mockResolvedValue({ data: { ...noCommand(), state: 'paused', command_known: true, allowed_actions: ['inspect', 'resume', 'cancel'] } } as never)
    const { activate } = mount(api); await activate(); acknowledge()
    api.getCsvImport.mockResolvedValueOnce({ data: { ...preview.run, version: 9 } })
    api.resumeCsvImport.mockRejectedValue(new Error('lost accepted response'))
    api.getCsvImportApply.mockResolvedValue({ data: { ...noCommand(), state: 'paused', pending_command: oldPacket, allowed_actions: ['inspect', 'resume', 'cancel'] } } as never)
    find<HTMLButtonElement>('[data-csv-resume]').click()
    await vi.waitFor(() => expect(api.resumeCsvImport).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(find<HTMLButtonElement>('[data-csv-retry-command]').disabled).toBe(false))
    find<HTMLButtonElement>('[data-csv-retry-command]').click()
    await vi.waitFor(() => expect(api.resumeCsvImport).toHaveBeenCalledTimes(2))
    const first = api.resumeCsvImport.mock.calls[0]![0].body as ApplyCommand
    expect(first.command_id).not.toBe(oldPacket.command_id); expect(first.version).toBe(9)
    expect(api.resumeCsvImport.mock.calls[1]![0].body).toEqual(first)
    expect(api.applyCsvImport).not.toHaveBeenCalled()
  })
})
