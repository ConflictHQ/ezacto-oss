/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest'
import {
  invoiceTabs,
  renderAppShell,
  webAssets,
} from './support/shell-harness.js'

describe('shell chrome visibility', () => {
  const renderStyledShell = (section?: 'client-list'): void => {
    document.open()
    document.write(
      renderAppShell({
        environment: 'test',
        release: 'browser-test',
        ...(section === undefined
          ? {}
          : { activeSection: 'Clients' as const, view: section }),
        sessionCookiePresent: true,
      })
        .replace(
          / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
          '',
        )
        .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
    )
    document.close()
    const stylesheet = document.createElement('style')
    stylesheet.textContent = webAssets.stylesheet
    document.head.append(stylesheet)
  }

  it('[unit] serves a stylesheet in which the hidden attribute actually hides', () => {
    // `hidden` is only a presentational default, so `.tabstrip { display: flex }`
    // beat it and Time's Week/Day strip painted on Clients, Projects, Invoices
    // and Reports, while `.primary-nav a { display: grid }` did the same to the
    // Approvals and Team items module gating had switched off. Assert what a
    // browser computes from the stylesheet the worker serves: a test that
    // matched the text of the rule would pass on a rule the cascade ignores.
    renderStyledShell('client-list')

    const strip = document.querySelector<HTMLElement>('.tabstrip')!
    const approvals = document.querySelector<HTMLElement>(
      '.primary-nav [data-approvals-nav]',
    )!
    expect(strip.hidden).toBe(true)
    expect(approvals.hidden).toBe(true)
    expect(window.getComputedStyle(strip).display).toBe('none')
    expect(window.getComputedStyle(approvals).display).toBe('none')

    // And still lays both out when they are not hidden, so the assertions above
    // are about `hidden` and not about a selector that matches nothing.
    renderStyledShell()
    const timeStrip = document.querySelector<HTMLElement>('.tabstrip')!
    const timeNav = document.querySelector<HTMLElement>('.primary-nav a')!
    expect(timeStrip.hidden).toBe(false)
    expect(window.getComputedStyle(timeStrip).display).toBe('flex')
    expect(window.getComputedStyle(timeNav).display).toBe('grid')
  })
})

describe('level-2 signal', () => {
  const renderStyled = (options: Parameters<typeof renderAppShell>[0]): void => {
    document.open()
    document.write(
      renderAppShell(options)
        .replace(
          / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
          '',
        )
        .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
    )
    document.close()
    const stylesheet = document.createElement('style')
    stylesheet.textContent = webAssets.stylesheet
    document.head.append(stylesheet)
  }

  it('[acceptance] paints Time\'s view modes as a segmented control and leaves the underline to real tabs', () => {
    // Week and Day are two ways of looking at one screen; Invoices' four
    // destinations are four parts of the app. Both wore the same 3px orange
    // underline, so the strongest signal in the chrome said "section" in one
    // place and "view mode" in the other. Assert what a browser computes from
    // the stylesheet the worker serves, because the rule that has to lose here
    // is `.tabstrip a[aria-current="page"]`, which still matches.
    renderStyled({
      environment: 'test',
      release: 'browser-test',
      sessionCookiePresent: true,
    })
    const strip = document.querySelector<HTMLElement>('[data-time-views]')!
    const [week, day] = [...strip.querySelectorAll<HTMLAnchorElement>('a')]

    // Still a tab strip, not a widget: a nav of real links, keyboard reachable,
    // with aria-current on the view you are looking at.
    expect(strip.tagName).toBe('NAV')
    expect(strip.getAttribute('aria-label')).toBe('Time views')
    expect(week!.getAttribute('href')).toBe('/')
    expect(day!.getAttribute('href')).toBe('/?view=day')
    expect(week!.getAttribute('aria-current')).toBe('page')
    expect(day!.hasAttribute('aria-current')).toBe(false)

    const activeMode = window.getComputedStyle(week!)
    const idleMode = window.getComputedStyle(day!)
    expect(activeMode.backgroundColor).toBe('#FDEDE3')
    expect(activeMode.borderTopColor).toBe('#E8590C')
    expect(activeMode.boxShadow).toBe('none')
    expect(idleMode.backgroundColor).not.toBe('#FDEDE3')
    expect(idleMode.borderTopColor).toBe('#E3E5E8')

    // And the underline it gave up is still the mark of a level-2 tab.
    renderStyled({
      environment: 'test',
      release: 'browser-test',
      activeSection: 'Invoices',
      view: 'invoice-list',
      tabs: invoiceTabs('invoice-list'),
      sessionCookiePresent: true,
    })
    const overview = document.querySelector<HTMLAnchorElement>(
      '.tabstrip a[aria-current="page"]',
    )!
    expect(overview.textContent).toBe('Overview')
    const currentTab = window.getComputedStyle(overview)
    expect(currentTab.boxShadow).toBe('inset 0 -3px #E8590C')
    expect(currentTab.backgroundColor).not.toBe('#FDEDE3')
  })
})
