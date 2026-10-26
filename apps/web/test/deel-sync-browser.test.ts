/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeelSyncController, type DeelSyncApi } from '../src/staff-payments/deel-sync-browser.js'

const status = {
  configured: true,
  reason: null,
  mode: 'manual' as const,
  run_time: '03:00',
  updated_at: '2026-10-19T00:00:00.000Z',
  updated_by_user_id: null,
  runs: [],
}

const preview = {
  status: 'ready' as const,
  window: { from: '2026-09-02', to: '2026-09-03' },
  entry_ids: [1, 2, 3],
  timesheets: 2,
  already_transferred: 0,
  conflicts: [],
  unsyncable: [],
  unmatched: [],
}

const mount = () => {
  document.body.innerHTML = `
    <section data-deel-sync>
      <p data-deel-sync-status></p>
      <form data-deel-sync-settings>
        <select name="mode"><option value="manual">Manual</option><option value="automatic">Automatic</option></select>
        <input name="run_time" type="time" />
      </form>
      <form data-deel-sync-preview>
        <input name="from" type="date" /><input name="to" type="date" />
      </form>
      <div data-deel-sync-preview-result></div>
      <input type="checkbox" data-deel-sync-reviewed disabled />
      <button type="button" data-deel-sync-send disabled>Send</button>
      <p data-deel-sync-message></p>
      <div data-deel-sync-runs></div>
    </section>`
  return document.querySelector<HTMLElement>('[data-deel-sync]')!
}

const api = (): Required<DeelSyncApi> => ({
  getDeelSync: vi.fn(async () => status),
  updateDeelSyncSettings: vi.fn(async () => {}),
  previewDeelSync: vi.fn(async () => preview),
  runDeelSync: vi.fn(async () => ({
    status: 'completed' as const,
    run_id: 4,
    timesheets_submitted: 2,
    entries_transferred: 3,
    failed: [],
    reconciliation: null,
    error: null,
  })),
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Deel sync panel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('shows the status and sends nothing until the preview is reviewed', async () => {
    const section = mount()
    const client = api()
    const controller = createDeelSyncController(document.body, client)
    await controller.activate(new AbortController().signal)
    expect(section.hidden).toBe(false)
    expect(document.querySelector('[data-deel-sync-status]')?.textContent).toContain('nothing is sent until you preview')

    const previewForm = document.querySelector<HTMLFormElement>('[data-deel-sync-preview]')!
    ;(previewForm.elements.namedItem('from') as HTMLInputElement).value = '2026-09-02'
    ;(previewForm.elements.namedItem('to') as HTMLInputElement).value = '2026-09-03'
    previewForm.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()

    expect(client.previewDeelSync).toHaveBeenCalledWith(
      expect.objectContaining({ body: { from: '2026-09-02', to: '2026-09-03' } }),
    )
    expect(document.querySelector('[data-deel-sync-preview-result]')?.textContent).toContain('2 timesheets (3 entries)')
    const send = document.querySelector<HTMLButtonElement>('[data-deel-sync-send]')!
    const reviewed = document.querySelector<HTMLInputElement>('[data-deel-sync-reviewed]')!
    expect(send.disabled).toBe(true)
    expect(client.runDeelSync).not.toHaveBeenCalled()

    reviewed.disabled = false
    reviewed.checked = true
    reviewed.dispatchEvent(new Event('change'))
    expect(send.disabled).toBe(false)

    send.click()
    await flush()
    expect(client.runDeelSync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { from: '2026-09-02', to: '2026-09-03', entry_ids: [1, 2, 3] },
      }),
    )
    expect(document.querySelector('[data-deel-sync-message]')?.textContent).toContain('Run 4: Completed')
  })

  it('saves the mode and time the administrator chose', async () => {
    mount()
    const client = api()
    await createDeelSyncController(document.body, client).activate(new AbortController().signal)
    const settings = document.querySelector<HTMLFormElement>('[data-deel-sync-settings]')!
    ;(settings.elements.namedItem('mode') as HTMLSelectElement).value = 'automatic'
    ;(settings.elements.namedItem('run_time') as HTMLInputElement).value = '21:15'
    settings.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()

    expect(client.updateDeelSyncSettings).toHaveBeenCalledWith(
      expect.objectContaining({ body: { mode: 'automatic', run_time: '21:15' } }),
    )
  })

  it('announces a delayed save immediately and refuses a duplicate submit', async () => {
    mount()
    const client = api()
    let finish!: () => void
    client.updateDeelSyncSettings = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    await createDeelSyncController(document.body, client).activate(new AbortController().signal)
    const form = document.querySelector<HTMLFormElement>('[data-deel-sync-settings]')!
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(client.updateDeelSyncSettings).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-deel-sync-message]')?.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('[data-deel-sync-message]')?.textContent).toContain('Saving')
    expect((form.elements.namedItem('mode') as HTMLSelectElement).disabled).toBe(true)
    finish()
    await vi.waitFor(() => expect(document.querySelector('[data-deel-sync-message]')?.textContent).toContain('settings saved'))
    expect(document.querySelector('[data-deel-sync-message]')?.getAttribute('aria-busy')).toBe('false')
    expect((form.elements.namedItem('mode') as HTMLSelectElement).disabled).toBe(false)
  })

  it('discards a delayed preview after the session ends', async () => {
    const section = mount()
    const client = api()
    let finish!: (value: typeof preview) => void
    client.previewDeelSync = vi.fn(() => new Promise<typeof preview>(resolve => { finish = resolve }))
    const controller = createDeelSyncController(document.body, client)
    const active = new AbortController()
    await controller.activate(active.signal)
    document.querySelector<HTMLFormElement>('[data-deel-sync-preview]')!.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(document.querySelector('[data-deel-sync-message]')?.textContent).toContain('Reviewing')
    active.abort()
    finish(preview)
    await flush()
    expect(section.hidden).toBe(true)
    expect(document.querySelector('[data-deel-sync-preview-result]')?.textContent).toBe('')
    expect(document.querySelector('[data-deel-sync-message]')?.getAttribute('aria-busy')).toBe('false')
    expect(document.querySelector<HTMLButtonElement>('[data-deel-sync-send]')!.disabled).toBe(true)
  })
})
