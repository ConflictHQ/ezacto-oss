/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffPaymentReport } from '@ezacto/core'
import {
  createDeelPaymentStatusController,
  type DeelPaymentStatusApi,
} from '../src/staff-payments/deel-payment-status-browser.js'

const response = (values = {}) => ({ data: { configured: true, checked: 1, failed: 0, remaining: 0, ...values } })
const report = (month = '2026-09', staged = 1) => ({
  month, rows: [{ deel_staging: { staged_entries: staged } }],
}) as StaffPaymentReport
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const mount = () => {
  const api = { refreshDeelPaymentStatus: vi.fn<NonNullable<DeelPaymentStatusApi['refreshDeelPaymentStatus']>>().mockResolvedValue(response()) }
  const refresh = vi.fn(async () => {})
  const abort = new AbortController()
  const controller = createDeelPaymentStatusController(document.body, api, refresh)
  controller.activate(abort.signal)
  return { api, refresh, abort, controller, message: document.querySelector<HTMLElement>('[data-deel-payment-refresh]')! }
}

describe('automatic Deel payment status refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<p data-deel-payment-refresh hidden role="status" aria-live="polite"></p>'
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('checks saved receipts automatically, shows progress, and never overlaps requests', async () => {
    const { api, refresh, abort, controller, message } = mount()
    const pending = deferred<ReturnType<typeof response>>()
    api.refreshDeelPaymentStatus.mockReturnValueOnce(pending.promise)
    controller.update(report())
    await vi.advanceTimersByTimeAsync(0)
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledWith({ body: { month: '2026-09' }, signal: abort.signal })
    expect(message.textContent).toContain('Checking payment status in Deel')
    expect(message.getAttribute('aria-busy')).toBe('true')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledTimes(1)
    pending.resolve(response())
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledWith('2026-09', abort.signal)
    expect(message.getAttribute('aria-busy')).toBe('false')
    expect(message.textContent).toContain('Showing the latest confirmed Deel statuses')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledTimes(2)
    abort.abort()
  })

  it('automatically continues through remaining receipts before the regular refresh interval', async () => {
    const { api, refresh, abort, controller, message } = mount()
    api.refreshDeelPaymentStatus.mockResolvedValueOnce(response({ checked: 20, remaining: 2 }))
    controller.update(report())
    await vi.advanceTimersByTimeAsync(0)
    expect(message.textContent).toContain('remaining Deel hours')
    await vi.advanceTimersByTimeAsync(1499)
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(message.textContent).toContain('Showing the latest confirmed Deel statuses')
    abort.abort()
  })

  it('keeps the last confirmed status visible when checks fail and retries later', async () => {
    const { api, refresh, abort, controller, message } = mount()
    api.refreshDeelPaymentStatus.mockRejectedValueOnce(new Error('network lost'))
    api.refreshDeelPaymentStatus.mockResolvedValueOnce(response({ failed: 1 }))
    controller.update(report())
    await vi.advanceTimersByTimeAsync(0)
    expect(message.textContent).toContain('Showing the last confirmed status')
    expect(message.getAttribute('aria-busy')).toBe('false')
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(message.textContent).toContain('Some Deel statuses could not be checked')
    expect(refresh).toHaveBeenCalledTimes(1)
    abort.abort()
  })

  it('does not poll while the document is hidden and resumes when visible', async () => {
    const { api, abort, controller } = mount()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    controller.update(report())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.refreshDeelPaymentStatus).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledTimes(1)
    abort.abort()
  })

  it('discards an old month response and refreshes the newly selected month', async () => {
    const { api, refresh, abort, controller } = mount()
    const pending = deferred<ReturnType<typeof response>>()
    api.refreshDeelPaymentStatus.mockReturnValueOnce(pending.promise)
    controller.update(report())
    await vi.advanceTimersByTimeAsync(0)
    controller.update(report('2026-10'))
    await vi.advanceTimersByTimeAsync(0)
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledTimes(1)
    pending.resolve(response())
    await vi.advanceTimersByTimeAsync(1)
    expect(api.refreshDeelPaymentStatus).toHaveBeenLastCalledWith({ body: { month: '2026-10' }, signal: abort.signal })
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith('2026-10', abort.signal)
    abort.abort()
  })

  it('clears private state on abort and ignores a late response', async () => {
    const { api, refresh, abort, controller, message } = mount()
    const pending = deferred<ReturnType<typeof response>>()
    api.refreshDeelPaymentStatus.mockReturnValueOnce(pending.promise)
    controller.update(report())
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    pending.resolve(response())
    await vi.advanceTimersByTimeAsync(90_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(api.refreshDeelPaymentStatus).toHaveBeenCalledOnce()
    expect(message.textContent).toBe('')
    expect(message.hidden).toBe(true)
    expect(message.getAttribute('aria-busy')).toBe('false')
  })

  it('does not poll without staged receipts or without the optional provider API', async () => {
    const { api, abort, controller, message } = mount()
    controller.update(report('2026-09', 0))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(api.refreshDeelPaymentStatus).not.toHaveBeenCalled()
    const refresh = vi.fn(async () => {})
    const unavailable = createDeelPaymentStatusController(document.body, {}, refresh)
    unavailable.activate(abort.signal)
    unavailable.update(report())
    await vi.advanceTimersByTimeAsync(90_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(message.hidden).toBe(true)
    abort.abort()
  })
})
