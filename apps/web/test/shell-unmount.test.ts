/** @vitest-environment happy-dom */

import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  mountShell,
  renderBrowserShell,
  unmount,
} from './support/shell-harness.js'

// Node gives a worker no `gc` unless it was started with --expose-gc, and CI
// does not start it that way. Turning the flag on at runtime exposes the same
// collector through a fresh context.
setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const retainedMegabytes = (): number => {
  collect()
  collect()
  return process.memoryUsage().heapUsed / 1_048_576
}

describe('shell unmount (issue 745)', () => {
  const stubFetch = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
  }

  const mountOnce = async (): Promise<void> => {
    stubFetch()
    renderBrowserShell({ view: 'settings-company' })
    await mountShell(browserApi())
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20))
    await unmount()
    vi.unstubAllGlobals()
  }

  it('[unit] a mounted and unmounted shell does not stay in the heap', async () => {
    // Measured on the same machine: each mount kept about 83 MB until its
    // timers, listeners, write-status subscription and mock call records were
    // released, and about 0.2 MB after. The bound is 12 MB a mount, so a
    // regression to even a seventh of the old cost fails and run-to-run
    // collector noise does not.
    await mountOnce()
    const baseline = retainedMegabytes()
    const mounts = 5
    for (let index = 0; index < mounts; index += 1) await mountOnce()
    const grownBy = retainedMegabytes() - baseline
    expect(grownBy / mounts).toBeLessThan(12)
  }, 120_000)

  it('[unit] unmount stops intervals, drops window listeners and empties the page', async () => {
    stubFetch()
    renderBrowserShell({ view: 'settings-company' })
    await mountShell(browserApi())
    expect(document.querySelector('[data-authenticated-shell]')).not.toBeNull()
    let ticks = 0
    globalThis.setInterval(() => {
      ticks += 1
    }, 5)
    let heard = 0
    globalThis.addEventListener('hashchange', () => {
      heard += 1
    })
    await unmount()
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30))
    globalThis.dispatchEvent(new Event('hashchange'))
    expect(ticks).toBe(0)
    expect(heard).toBe(0)
    expect(document.querySelector('[data-authenticated-shell]')).toBeNull()
    vi.unstubAllGlobals()
  })
})
