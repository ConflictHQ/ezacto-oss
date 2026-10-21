/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledRun } from '@ezacto/core'
import { createScheduledRunController } from '../src/scheduled-runs/browser.js'
import { renderScheduledRunPage } from '../src/scheduled-runs/render.js'
const run: ScheduledRun = {
  id: 1,
  job_id: 1,
  occurrence_key: '2026-09',
  state: 'proposed',
  proposed_at: '2026-10-01T09:00:00.000Z',
  expires_at: '2099-10-02T09:00:00.000Z',
  confirmed_by: null,
  confirmed_at: null,
  settled_reason: null,
  items: [
    {
      id: 1,
      subject_type: 'invoice',
      subject_id: 1,
      description: 'September detail <img src=x>',
      client_name: 'Client A',
      quantity_seconds: 5400,
      amount_cents: 10000,
      currency: 'USD',
      target: 'accounts@example.test',
      state: 'pending',
      attempt_count: 0,
      failure_reason: null,
      completed_at: null,
    },
  ],
}
const button = (selector: string) =>
  document.querySelector<HTMLButtonElement>(`[data-scheduled-run-${selector}]`)!
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
beforeEach(() => {
  window.history.replaceState({}, '', '/scheduled-runs/1')
  document.body.innerHTML = renderScheduledRunPage('scheduled-run')
})
describe('authenticated manifest screen (#61)', () => {
  it('shows every concrete field as text and makes no decision on activation or refresh', async () => {
    const read = vi.fn(async () => ({ data: run })),
      confirm = vi.fn(),
      cancel = vi.fn()
    await createScheduledRunController({ read, confirm, cancel }).activate(
      new AbortController().signal,
      true,
    )
    expect(document.body.textContent).toContain('Client A')
    expect(document.body.textContent).toContain('1h 30m')
    expect(document.body.textContent).toContain('USD 100.00')
    expect(document.body.textContent).toContain('accounts@example.test')
    expect(document.querySelector('img')).toBeNull()
    button('refresh').click()
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(confirm).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
  it('records an explicit answer once and hides consumed controls', async () => {
    const confirm = vi.fn(async () => ({
      data: {
        ...run,
        state: 'confirmed' as const,
        confirmed_by: 1,
        confirmed_at: '2026-10-01T10:00:00.000Z',
      },
    }))
    await createScheduledRunController({
      read: async () => ({ data: run }),
      confirm,
      cancel: vi.fn(),
    }).activate(new AbortController().signal, true)
    button('confirm').click()
    button('confirm').click()
    await flush()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLElement>('[data-scheduled-run-actions]')!.hidden).toBe(true)
    expect(document.body.textContent).toContain('Confirmation recorded')
  })
  it('clears private data on abort and ignores an old session response', async () => {
    let resolve!: (value: { data: ScheduledRun }) => void
    const signal = new AbortController()
    const activated = createScheduledRunController({
      read: () =>
        new Promise((done) => {
          resolve = done
        }),
      confirm: vi.fn(),
      cancel: vi.fn(),
    }).activate(signal.signal, true)
    signal.abort()
    resolve({ data: run })
    await activated
    expect(document.body.textContent).not.toContain('accounts@example.test')
    expect(document.body.textContent).toContain('Sign in to review')
  })
  it('requires refresh after an ambiguous mutation and does not expose actions for expired/member contexts', async () => {
    const confirm = vi.fn(async () => {
      throw new Error('response lost')
    })
    const controller = createScheduledRunController({
      read: async () => ({ data: run }),
      confirm,
      cancel: vi.fn(),
    })
    await controller.activate(new AbortController().signal, true)
    button('confirm').click()
    await flush()
    expect(document.body.textContent).toContain('answer could not be verified')
    button('confirm').click()
    expect(confirm).toHaveBeenCalledTimes(1)
    await controller.activate(new AbortController().signal, false)
    expect(document.body.textContent).not.toContain('accounts@example.test')
    expect(document.body.textContent).toContain('Only administrators')
    await createScheduledRunController({
      read: async () => ({ data: { ...run, expires_at: '2020-01-01T00:00:00.000Z' } }),
      confirm,
      cancel: vi.fn(),
    }).activate(new AbortController().signal, true)
    expect(document.querySelector<HTMLElement>('[data-scheduled-run-actions]')!.hidden).toBe(true)
  })
})
