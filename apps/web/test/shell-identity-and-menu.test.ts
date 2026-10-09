/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { renderAppShell } from '../src/shell/render.js'
import {
  browserApi,
  mountShell,
  renderBrowserShell,
  type ShellApi,
} from './support/shell-harness.js'

/**
 * The identity card read "Administrator / User #1": nothing gave the shell the
 * person's name. The profile now carries it, and the card leads with it.
 */
describe('identity card', () => {
  const withProfile = (profile: Record<string, unknown>): ShellApi => ({
    ...browserApi(),
    getProfile: vi.fn(async () => ({ user_id: 1, timezone: 'UTC', ...profile })),
  })

  it('[browser] leads with the person\'s name and keeps the role under it', async () => {
    renderBrowserShell()
    await mountShell(
      withProfile({ first_name: 'Ada', last_name: 'Quill', email: 'ada@example.test' }),
    )
    const name = document.querySelector<HTMLElement>('[data-current-name]')!
    await vi.waitFor(() => expect(name.textContent).toBe('Ada Quill'))
    expect(name.hidden).toBe(false)
    expect(document.querySelector('[data-current-profile]')?.textContent).toBe('administrator')
    const card = document.querySelector<HTMLElement>('[data-current-identity]')!
    expect(card.textContent).not.toContain('User #')
    expect(card.title).toBe('ada@example.test')
  })

  it('[browser] falls back to the address, then to the role, when no name comes', async () => {
    renderBrowserShell()
    await mountShell(withProfile({ first_name: ' ', last_name: '', email: 'ada@example.test' }))
    const name = document.querySelector<HTMLElement>('[data-current-name]')!
    await vi.waitFor(() => expect(name.textContent).toBe('ada@example.test'))

    renderBrowserShell()
    await mountShell(withProfile({}))
    const bare = document.querySelector<HTMLElement>('[data-current-name]')!
    // An older server sends no name: the card shows the role alone, not a blank.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-profile]')?.textContent).toBe('administrator'),
    )
    expect(bare.hidden).toBe(true)
  })
})

/**
 * The Menu's destinations are cards of their own. They used to be the
 * sidebar's links, so collapsing the sidebar (which hides `.nav-label`) left
 * the Menu a column of bare icons.
 */
describe('menu cards', () => {
  const html = renderAppShell({ release: 'test', environment: 'test', sidebar: 'collapsed' })
  const menu = (): Element => {
    document.body.innerHTML = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>') + 7)
    return document.querySelector('[data-menu-dialog]')!
  }

  it('[unit] renders every destination as a titled, described card, never a nav-label', () => {
    const dialog = menu()
    const cards = [...dialog.querySelectorAll<HTMLAnchorElement>('a.menu-card')]
    expect(cards.length).toBeGreaterThanOrEqual(11)
    expect(dialog.querySelector('.nav-label')).toBeNull()
    for (const card of cards) {
      const title = card.querySelector('.menu-card-title')?.textContent ?? ''
      const hint = card.querySelector<HTMLElement>('.menu-card-hint')!
      expect(title).not.toBe('')
      expect(hint.textContent).not.toBe('')
      // The hint describes the link; its name stays the section alone.
      expect(card.getAttribute('aria-describedby')).toBe(hint.id)
    }
    // The command bar reads the folded destinations through this hook.
    expect(dialog.querySelector('nav.secondary-nav[data-secondary-nav] a.menu-card')).not.toBeNull()
  })

  it('[unit] the collapsed-sidebar rule cannot reach a menu card', () => {
    const css = readFileSync('src/shell/shell.css', 'utf8')
    const collapsedRules = css.match(/\[data-ez-sidebar='collapsed'\][^{]*\{/gu) ?? []
    expect(collapsedRules.length).toBeGreaterThan(0)
    for (const rule of collapsedRules) expect(rule).not.toMatch(/menu-card/u)
  })
})
