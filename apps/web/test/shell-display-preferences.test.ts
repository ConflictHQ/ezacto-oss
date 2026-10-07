/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from 'vitest'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

const forget = (...names: readonly string[]): void => {
  for (const name of names) document.cookie = `${name}=; Path=/; Max-Age=0`
}

const choice = (scheme: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-color-scheme-choice="${scheme}"]`)!

describe('light, dark, or the system in the browser (the 2026-10 reskin)', () => {
  afterEach(() => forget('ezacto_scheme'))

  it('[browser] switches in place, keeps the choice in a cookie, and marks it pressed', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())
    const root = document.documentElement
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')!

    expect(root.getAttribute('data-ez-scheme')).toBe('system')
    expect(choice('system').getAttribute('aria-pressed')).toBe('true')

    choice('dark').click()
    expect(root.getAttribute('data-ez-scheme')).toBe('dark')
    expect(meta.getAttribute('content')).toBe('dark')
    // In a cookie and not in storage, because the server has to read it to
    // paint the next page dark from its first byte.
    expect(document.cookie).toContain('ezacto_scheme=dark')
    expect(choice('dark').getAttribute('aria-pressed')).toBe('true')
    expect(choice('system').getAttribute('aria-pressed')).toBe('false')

    choice('system').click()
    expect(root.getAttribute('data-ez-scheme')).toBe('system')
    expect(meta.getAttribute('content')).toBe('light dark')
    expect(document.cookie).not.toContain('ezacto_scheme')
  })

  it('[browser] starts from the same cookie the server rendered the page from', async () => {
    document.cookie = 'ezacto_scheme=light; Path=/'
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())
    expect(document.documentElement.getAttribute('data-ez-scheme')).toBe('light')
    expect(choice('light').getAttribute('aria-pressed')).toBe('true')
    expect(choice('system').getAttribute('aria-pressed')).toBe('false')
  })
})
