/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { bindSkipNavigation } from '../src/shell/skip-navigation.js'

afterEach(() => {
  document.body.innerHTML = ''
  delete document.documentElement.dataset.authState
  vi.restoreAllMocks()
})

const fixture = () => {
  document.documentElement.dataset.authState = 'authenticated'
  document.body.innerHTML = `<div data-authenticated-shell>
    <a href="#app-content" data-app-skip-link>Skip navigation</a>
    <main class="app-content" hidden>Week</main>
    <main class="app-content">Expenses</main></div>`
  const shell = document.querySelector<HTMLElement>('[data-authenticated-shell]')!
  const target = shell.querySelectorAll<HTMLElement>('main')[1]!
  const scroll = vi.fn()
  target.scrollIntoView = scroll
  bindSkipNavigation(shell)
  return { shell, target, scroll, link: shell.querySelector<HTMLAnchorElement>('a')! }
}

it('focuses the visible business page, bypassing the hidden week without navigation', () => {
  const { link, target, scroll } = fixture()
  const before = { url: location.href, history: history.length }
  link.click()
  expect(document.activeElement).toBe(target)
  expect(target.tabIndex).toBe(-1)
  expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  expect({ url: location.href, history: history.length }).toEqual(before)
})

it.each([
  'inert',
  'hidden',
  'checking',
  'signed-out',
  'hidden-target',
  'inert-target',
  'css-hidden',
])('refuses focus while %s', (state) => {
  const { shell, target, scroll, link } = fixture()
  if (state === 'inert' || state === 'hidden') shell.setAttribute(state, '')
  else if (state === 'hidden-target') target.hidden = true
  else if (state === 'inert-target') target.setAttribute('inert', '')
  else if (state === 'css-hidden') target.style.display = 'none'
  else document.documentElement.dataset.authState = state
  link.click()
  expect(document.activeElement).not.toBe(target)
  expect(scroll).not.toHaveBeenCalled()
  expect(target.hasAttribute('tabindex')).toBe(false)
})
