/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCalendarConnectionController } from '../src/calendar-connections/browser.js'
import { renderCalendarConnections } from '../src/calendar-connections/render.js'
import type {
  CalendarConnection,
  CalendarConnectionApi,
} from '../src/calendar-connections/model.js'
const row = (extra: Partial<CalendarConnection> = {}): CalendarConnection => ({
  provider: 'google',
  status: 'disconnected',
  generation: 0,
  last_synced_at: null,
  last_error: null,
  syncing: false,
  cleanup_pending: false,
  available: true,
  ...extra,
})
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label)!
const status = () => document.querySelector('[role=status]')!
const setup = (apiOverrides: Partial<CalendarConnectionApi> = {}) => {
  const api: CalendarConnectionApi = {
    list: vi.fn(async () => ({ data: [row()] })),
    authorize: vi.fn(async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque'),
    refresh: vi.fn(async () => ({ data: { state: 'connected' as const, applied: 2 } })),
    disconnect: vi.fn(async () => {}),
    ...apiOverrides,
  }
  const host = { navigate: vi.fn(), sessionFailure: vi.fn(() => false) }
  const controller = createCalendarConnectionController(
    document.querySelector('section')!,
    api,
    host,
  )
  const signal = new AbortController()
  controller.activate(signal.signal)
  return { api, host, controller, signal }
}
beforeEach(() => {
  document.body.innerHTML = renderCalendarConnections()
})
describe('calendar consent controls', () => {
  it('uses the selected generation, shows busy, and prevents duplicate consent requests', async () => {
    const pending = deferred<string>()
    const { api, host } = setup({ authorize: vi.fn(() => pending.promise) })
    await flush()
    button('Connect').click()
    button('Connect').click()
    expect(api.authorize).toHaveBeenCalledTimes(1)
    expect(api.authorize).toHaveBeenCalledWith('google', 0, expect.any(AbortSignal))
    expect(status().textContent).toContain('Opening Google consent')
    expect(status().getAttribute('aria-busy')).toBe('true')
    pending.resolve('https://accounts.google.com/o/oauth2/v2/auth?state=opaque')
    await flush()
    expect(host.navigate).toHaveBeenCalledOnce()
  })
  it('never navigates after signout or to an unexpected provider origin', async () => {
    const pending = deferred<string>()
    const { signal, host } = setup({ authorize: () => pending.promise })
    await flush()
    button('Connect').click()
    signal.abort()
    pending.resolve('https://accounts.google.com/o/oauth2/v2/auth')
    await flush()
    expect(host.navigate).not.toHaveBeenCalled()
    expect(document.querySelector('[data-calendar-connections]')!.hasAttribute('hidden')).toBe(true)
    document.body.innerHTML = renderCalendarConnections()
    const second = setup({ authorize: async () => 'https://attacker.invalid/collect' })
    await flush()
    button('Connect').click()
    await flush()
    expect(second.host.navigate).not.toHaveBeenCalled()
    expect(status().textContent).toContain('could not be confirmed')
  })
  it.each([
    'https://accounts.google.com/unrelated',
    'https://accounts.google.com/o/oauth2/v2/auth#unexpected',
  ])('rejects an unexpected consent path or fragment: %s', async (url) => {
    const { host } = setup({ authorize: async () => url })
    await flush()
    button('Connect').click()
    await flush()
    expect(host.navigate).not.toHaveBeenCalled()
    expect(status().textContent).toContain('could not be confirmed')
  })
  it('does not claim sync success when the status refresh fails', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [row({ status: 'connected', generation: 2 })] })
      .mockRejectedValueOnce(new Error('private server message'))
    setup({ list })
    await flush()
    button('Sync calendar').click()
    await flush()
    expect(status().textContent).toContain(
      'operation finished, but connection status could not be refreshed',
    )
    expect(status().textContent).not.toContain('private server message')
    expect(status().getAttribute('aria-busy')).toBe('false')
  })
  it('shows reconnect and provider cleanup honestly, and keeps reconnect blocked during cleanup', async () => {
    setup({
      list: async () => ({
        data: [
          row({ status: 'needs_reauth' }),
          row({ provider: 'microsoft', cleanup_pending: true }),
        ],
      }),
    })
    await flush()
    expect(button('Reconnect').disabled).toBe(false)
    expect(button('Connect').disabled).toBe(true)
    expect(document.body.textContent).toContain('review access in your provider account settings')
  })
  it('disconnects with the current generation then reflects durable provider cleanup', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [row({ status: 'connected', generation: 4 })] })
      .mockResolvedValueOnce({ data: [row({ generation: 5, cleanup_pending: true })] })
    const { api } = setup({ list })
    await flush()
    button('Disconnect').click()
    await flush()
    expect(api.disconnect).toHaveBeenCalledWith('google', 4, expect.any(AbortSignal))
    expect(button('Connect').disabled).toBe(true)
    expect(status().textContent).toContain('Disconnected here')
  })
  it('explains Microsoft administrator consent without reflecting provider errors', async () => {
    const { controller, signal } = setup()
    controller.activate(signal.signal, 'admin_consent_required', 'microsoft')
    await flush()
    expect(status().textContent).toBe('Your Microsoft tenant requires administrator approval. Contact your tenant administrator, then try connecting again.')
  })
  it('does not overwrite load failure with successful callback wording', async () => {
    const { controller, signal } = setup({
      list: async () => {
        throw new Error('secret')
      },
    })
    controller.activate(signal.signal, 'connected')
    await flush()
    expect(status().textContent).toContain('could not be loaded')
    expect(status().textContent).not.toContain('consent completed')
  })
  it('requires deliberate Microsoft permission-removal confirmation and labels it as operator evidence', async () => {
    const item = {
      id: 'owned-obligation',
      generation: 3,
      credential_revision: 4,
      reason: 'disconnect' as const,
      created_at: '2026-10-26T00:00:00Z',
    }
    const confirmation = deferred<void>()
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [row({ provider: 'microsoft', generation: 3, cleanup_pending: true })],
      })
      .mockResolvedValueOnce({ data: [row({ provider: 'microsoft', generation: 3 })] })
    const manualCleanup = vi.fn().mockResolvedValueOnce([item]).mockResolvedValueOnce([])
    const { api } = setup({
      list,
      manualCleanup,
      confirmManualCleanup: vi.fn(() => confirmation.promise),
    })
    await flush()
    expect(button('Record permission removal').disabled).toBe(true)
    expect(document.body.textContent).toContain('does not verify removal with Microsoft')
    const check = document.querySelector<HTMLInputElement>('input[type=checkbox]')!
    check.checked = true
    check.dispatchEvent(new Event('change'))
    button('Record permission removal').click()
    button('Record permission removal').click()
    expect(api.confirmManualCleanup).toHaveBeenCalledExactlyOnceWith(item, expect.any(AbortSignal))
    confirmation.resolve()
    await flush()
    expect(status().textContent).toContain('Your permission-removal confirmation was recorded')
    expect(button('Connect').disabled).toBe(false)
  })
  it('clears old account data and ignores an old load after reactivation', async () => {
    const old = deferred<{ data: CalendarConnection[] }>()
    const list = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ data: [] })
    const { controller } = setup({ list })
    controller.activate(new AbortController().signal)
    await flush()
    old.resolve({ data: [row()] })
    await flush()
    expect(document.body.textContent).toContain('not configured')
    expect(document.querySelector('[data-calendar-connections-list]')!.textContent).not.toContain(
      'Google',
    )
  })
})
