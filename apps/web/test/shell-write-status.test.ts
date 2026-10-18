/** @vitest-environment happy-dom */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSameOriginShellApi } from '../src/shell/model.js'
import { createPendingWrites, shellPendingWrites } from '../src/shell/net.js'
import { bindWriteStatus, writeStatusMessage } from '../src/shell/write-status.js'
import {
  browserApi,
  mountShell,
  renderBrowserShell,
  webAssets,
} from './support/shell-harness.js'

/**
 * The shell's word on a write it is sending again (issue 953), and the guard
 * that keeps a page from closing over a write still unsent.
 */

const statusElements = (): { status: HTMLElement; message: HTMLElement } => {
  document.body.innerHTML =
    '<aside data-write-status hidden><span data-write-status-message></span></aside>'
  return {
    status: document.querySelector<HTMLElement>('[data-write-status]')!,
    message: document.querySelector<HTMLElement>('[data-write-status-message]')!,
  }
}

const leave = (): Event => {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('the write status line', () => {
  it('[unit] stays quiet for a write that lands on its first attempt', () => {
    const { status } = statusElements()
    const writes = createPendingWrites()
    bindWriteStatus(status, document.createElement('span'), writes)
    const write = writes.begin()
    expect(status.hidden).toBe(true)
    write.settle()
    expect(status.hidden).toBe(true)
  })

  it('[browser] shows while writes are being sent again, counts them, and clears when they settle', () => {
    const { status, message } = statusElements()
    const writes = createPendingWrites()
    bindWriteStatus(status, message, writes)

    const first = writes.begin()
    first.retrying()
    expect(status.hidden).toBe(false)
    expect(message.textContent).toBe('Saving… retrying')

    const second = writes.begin()
    second.retrying()
    expect(message.textContent).toBe('Saving 2 changes… retrying')

    first.settle()
    expect(status.hidden).toBe(false)
    expect(message.textContent).toBe('Saving… retrying')
    second.settle()
    expect(status.hidden).toBe(true)
  })

  it('[unit] words one write and several the same way', () => {
    expect(writeStatusMessage(1)).toBe('Saving… retrying')
    expect(writeStatusMessage(3)).toBe('Saving 3 changes… retrying')
  })

  it('[browser] asks before the page closes over a write still unsent, and only then', () => {
    const { status, message } = statusElements()
    const writes = createPendingWrites()
    const page = new EventTarget()
    bindWriteStatus(status, message, writes, page as unknown as Window)
    const close = (): Event => {
      const event = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(event)
      return event
    }

    expect(close().defaultPrevented).toBe(false)
    // On its first attempt too: a closed page cannot retry anything.
    const write = writes.begin()
    expect(close().defaultPrevented).toBe(true)
    write.retrying()
    expect(close().defaultPrevented).toBe(true)
    write.settle()
    expect(close().defaultPrevented).toBe(false)
  })
})

describe('the status line in the shell', () => {
  it('[browser] renders hidden, so the stylesheet keeps it out of the way until it is needed', () => {
    renderBrowserShell()
    const stylesheet = document.createElement('style')
    stylesheet.textContent = webAssets.stylesheet
    document.head.append(stylesheet)

    const status = document.querySelector<HTMLElement>('[data-write-status]')!
    expect(status.hidden).toBe(true)
    expect(status.getAttribute('role')).toBe('status')
    // `hidden` is only a presentational default, and the line has a `display`
    // of its own: what the browser computes is the proof it stays out of sight.
    expect(window.getComputedStyle(status).display).toBe('none')
    status.hidden = false
    expect(window.getComputedStyle(status).display).toBe('flex')
    expect(window.getComputedStyle(status).position).toBe('fixed')
  })

  it('[browser] is bound by mountShell, before sign-in, so a sign-in being retried shows it too', async () => {
    renderBrowserShell()
    const writes = createPendingWrites()
    await mountShell(browserApi(), writes)

    const status = document.querySelector<HTMLElement>('[data-write-status]')!
    expect(status.hidden).toBe(true)
    const write = writes.begin()
    write.retrying()
    expect(status.hidden).toBe(false)
    expect(document.querySelector('[data-write-status-message]')!.textContent).toBe(
      'Saving… retrying',
    )
    expect(leave().defaultPrevented).toBe(true)
    write.settle()
    expect(status.hidden).toBe(true)
    expect(leave().defaultPrevented).toBe(false)
  })
})

describe("the shell's own API", () => {
  it('[security] sends every write through the shell fetch: keyed, same-origin, and counted until it lands', async () => {
    const answered = Promise.withResolvers<Response>()
    const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValue(answered.promise)
    onTestFinished(() => fetch.mockRestore())

    const created = createSameOriginShellApi().createTimeEntry({
      project_id: 1,
      task_id: 1,
      spent_date: '2026-10-07',
      seconds: 3_600,
    })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(shellPendingWrites.unsent).toBe(1)

    const [, init] = fetch.mock.calls[0]!
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(new Headers(init?.headers).get('idempotency-key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )

    answered.resolve(
      new Response(
        JSON.stringify({
          data: { id: 9, project_id: 1, task_id: 1, spent_date: '2026-10-07', seconds: 3_600 },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    )
    await expect(created).resolves.toMatchObject({ id: 9 })
    expect(shellPendingWrites.unsent).toBe(0)
  })

  it('[unit] sends a read untouched and unkeyed', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            user_id: 1,
            profile: 'member',
            manager_grants: [],
            authentication: { kind: 'session' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    onTestFinished(() => fetch.mockRestore())

    await createSameOriginShellApi().whoami()

    const [, init] = fetch.mock.calls[0]!
    expect(init?.credentials).toBe('same-origin')
    expect(new Headers(init?.headers).has('idempotency-key')).toBe(false)
    expect(shellPendingWrites.unsent).toBe(0)
  })
})
