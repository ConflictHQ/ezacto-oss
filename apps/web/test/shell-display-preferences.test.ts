/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from 'vitest'
import { readCookie } from '../src/index.js'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

const forget = (...names: readonly string[]): void => {
  for (const name of names) document.cookie = `${name}=; Path=/; Max-Age=0`
}

/**
 * What the server would read. happy-dom keeps a cookie deleted with
 * `Max-Age=0` as an empty value where a browser drops it; the server resolves
 * an empty value to the default either way, so empty counts as unset here.
 */
const stored = (name: string): string | null => readCookie(document.cookie, name) || null

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
    expect(stored('ezacto_scheme')).toBe('dark')
    expect(choice('dark').getAttribute('aria-pressed')).toBe('true')
    expect(choice('system').getAttribute('aria-pressed')).toBe('false')

    // Dim sits between the two, and the browser's own controls go dark for it.
    choice('dim').click()
    expect(root.getAttribute('data-ez-scheme')).toBe('dim')
    expect(meta.getAttribute('content')).toBe('dark')
    expect(stored('ezacto_scheme')).toBe('dim')
    expect(choice('dim').getAttribute('aria-pressed')).toBe('true')
    expect(choice('dark').getAttribute('aria-pressed')).toBe('false')

    choice('system').click()
    expect(root.getAttribute('data-ez-scheme')).toBe('system')
    expect(meta.getAttribute('content')).toBe('light dark')
    expect(stored('ezacto_scheme')).toBeNull()
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

describe('one header, sidebar or top bar, in the browser (the 2026-10 reskin)', () => {
  afterEach(() => forget('ezacto_nav', 'ezacto_sidebar'))

  const layoutChoices = (layout: string): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(`[data-nav-layout-choice="${layout}"]`),
  ]

  it('[browser] switches layout in place from either switch, and keeps it in a cookie', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())
    const root = document.documentElement
    // One header, captured before the switch: switching is an attribute on the
    // root, not a second header, so the same nodes have to be there after.
    const header = document.querySelector<HTMLElement>('[data-app-nav]')!
    const links = [...header.querySelectorAll('.primary-nav a')]
    expect(document.querySelectorAll('[data-app-nav]')).toHaveLength(1)
    expect(root.getAttribute('data-ez-nav')).toBe('sidebar')

    // The pair in the Menu and the pair in Settings are the same choice.
    const inMenu = (layout: string): HTMLButtonElement =>
      layoutChoices(layout).find((button) => button.closest('[data-menu-dialog]') !== null)!
    const inSettings = (layout: string): HTMLButtonElement =>
      layoutChoices(layout).find(
        (button) => button.closest('[data-settings-user-page]') !== null,
      )!
    expect(layoutChoices('topbar')).toHaveLength(2)
    expect(inMenu('topbar')).toBeDefined()
    expect(inSettings('topbar')).toBeDefined()
    inMenu('topbar').click()
    expect(root.getAttribute('data-ez-nav')).toBe('topbar')
    expect(stored('ezacto_nav')).toBe('topbar')
    for (const button of layoutChoices('topbar')) {
      expect(button.getAttribute('aria-pressed')).toBe('true')
    }
    for (const button of layoutChoices('sidebar')) {
      expect(button.getAttribute('aria-pressed')).toBe('false')
    }
    expect(document.querySelector('[data-app-nav]')).toBe(header)
    expect([...header.querySelectorAll('.primary-nav a')]).toEqual(links)

    inSettings('sidebar').click()
    expect(root.getAttribute('data-ez-nav')).toBe('sidebar')
    expect(stored('ezacto_nav')).toBeNull()
  })

  it('[browser] narrows the sidebar to its icons and remembers it for this browser', async () => {
    renderBrowserShell()
    await mountShell(browserApi())
    const root = document.documentElement
    const toggle = document.querySelector<HTMLButtonElement>('[data-sidebar-toggle]')!
    expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    toggle.click()
    expect(root.getAttribute('data-ez-sidebar')).toBe('collapsed')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(stored('ezacto_sidebar')).toBe('collapsed')
    // Narrowed, every section keeps its name; only the eye loses the label.
    for (const link of document.querySelectorAll<HTMLAnchorElement>('.primary-nav a')) {
      expect(link.querySelector('.nav-label')?.textContent?.trim()).toBeTruthy()
    }

    toggle.click()
    expect(root.getAttribute('data-ez-sidebar')).toBe('expanded')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(stored('ezacto_sidebar')).toBeNull()
  })

  it('[browser] starts collapsed and on the top bar when the cookies say so', async () => {
    document.cookie = 'ezacto_nav=topbar; Path=/'
    document.cookie = 'ezacto_sidebar=collapsed; Path=/'
    renderBrowserShell()
    await mountShell(browserApi())
    expect(document.documentElement.getAttribute('data-ez-nav')).toBe('topbar')
    expect(document.documentElement.getAttribute('data-ez-sidebar')).toBe('collapsed')
    expect(
      document.querySelector('[data-sidebar-toggle]')!.getAttribute('aria-pressed'),
    ).toBe('true')
  })
})

