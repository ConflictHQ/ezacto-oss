import { EzactoApiError } from '@conflict-hq/ezacto-client'
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

it('[review-link #61] removes the credential before sign-in and records only an authenticated opening', async () => {
  const token = 'A'.repeat(43) + '.' + 'B'.repeat(43)
  window.history.replaceState({}, '', `/scheduled-runs/1#review=${token}`)
  document.body.innerHTML = renderScheduledRunPage('scheduled-run')
  const consumeReviewLink = vi.fn(async () => {}),
    confirm = vi.fn(),
    cancel = vi.fn(),
    read = vi.fn(async () => ({ data: run }))
  const controller = createScheduledRunController({ consumeReviewLink, read, confirm, cancel })
  expect(window.location.hash).toBe('')
  expect(consumeReviewLink).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  await controller.activate(signal, true)
  expect(consumeReviewLink).toHaveBeenCalledWith(1, token, signal)
  expect(read).toHaveBeenCalledTimes(1)
  expect(confirm).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
})

it('[review-link #61] an aborted link response cannot load private data into a later session', async () => {
  window.history.replaceState(
    {},
    '',
    `/scheduled-runs/1#review=${'A'.repeat(43)}.${'B'.repeat(43)}`,
  )
  document.body.innerHTML = renderScheduledRunPage('scheduled-run')
  let resolve!: () => void
  const signal = new AbortController(),
    read = vi.fn(async () => ({ data: run }))
  const controller = createScheduledRunController({
    consumeReviewLink: () =>
      new Promise<void>((done) => {
        resolve = done
      }),
    read,
    confirm: vi.fn(),
    cancel: vi.fn(),
  })
  const activated = controller.activate(signal.signal, true)
  signal.abort()
  resolve()
  await activated
  expect(read).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('accounts@example.test')
  expect(document.body.textContent).toContain('Sign in to review')
})

it('[review-link #61] does not fall back to a private read after the exchange reports lost administrator access', async () => {
  window.history.replaceState(
    {},
    '',
    `/scheduled-runs/1#review=${'A'.repeat(43)}.${'B'.repeat(43)}`,
  )
  document.body.innerHTML = renderScheduledRunPage('scheduled-run')
  const read = vi.fn(async () => ({ data: run }))
  await createScheduledRunController({
    consumeReviewLink: async () => {
      throw new EzactoApiError(403, { error: { code: 'profile_forbidden' } }, null)
    },
    read,
    confirm: vi.fn(),
    cancel: vi.fn(),
  }).activate(new AbortController().signal, true)
  expect(read).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Sign in with an administrator account')
  expect(document.body.textContent).not.toContain('accounts@example.test')
})
