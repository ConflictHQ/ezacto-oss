/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { commandShortcutModifier, type PlatformHints } from '../src/index.js'
import {
  browserApi,
  defaultTheme,
  edit,
  identity,
  mountShell,
  renderBrowserShell,
  secondIdentity,
  themeManifest,
  type ShellApi,
  type Whoami,
} from './support/shell-harness.js'

describe('command palette browser behavior', () => {
  // Approvals answers only when the module is there and the profile may review;
  // Team only when the module reports itself enabled. Both APIs are present for
  // every mount below, so what separates the two people in these tests is the
  // profile alone.
  const paletteApi = (whoami: Whoami): ShellApi => ({
    ...browserApi(),
    whoami: vi.fn(async () => whoami),
    listTimesheetSubmissions: vi.fn(async () => []),
    listPendingTimesheetSubmissions: vi.fn(async () => ({
      submissions: [],
      nextCursor: null,
    })),
    getTeamStatus: vi.fn(async () => ({ enabled: true })),
  })

  const openPalette = (): HTMLInputElement => {
    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    return document.querySelector<HTMLInputElement>('[name="command"]')!
  }

  const paletteLabels = (): string[] =>
    [...document.querySelectorAll<HTMLAnchorElement>('[data-command-option]')].map(
      (option) => option.textContent ?? '',
    )

  // Issue 461 folded Home, Tasks and Team into the Menu group. The palette
  // gates on whichever nav carries a destination, so the premise this test
  // rests on has to look in both.
  const navHidden = (href: string): boolean =>
    document.querySelector<HTMLElement>(
      `.primary-nav a[href="${href}"], .secondary-nav a[href="${href}"]`,
    )!.hidden

  it('[e2e] groups every destination the nav offers an administrator', async () => {
    renderBrowserShell()
    await mountShell(paletteApi(identity))
    await vi.waitFor(() => expect(navHidden('/approvals')).toBe(false))
    await vi.waitFor(() => expect(navHidden('/team')).toBe(false))

    // The tab must be revealed, not merely un-hidden by accident: it ships
    // hidden, so a reveal that forgets it leaves it hidden and every
    // member-side assertion still passes. This is the direction that catches it.
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-activity-tab]')!.hidden,
      ).toBe(false),
    )

    const command = openPalette()
    expect(paletteLabels()).toContain('Approvals')
    expect(paletteLabels()).toContain('Team')
    expect(paletteLabels()).toContain('Company settings')
    expect(paletteLabels()).toContain('Activity log')
    // Grouped by what you came to do, and only groups with results are drawn.
    expect(
      [...document.querySelectorAll<HTMLElement>('.command-group')].map((group) =>
        group.getAttribute('aria-label'),
      ),
    ).toEqual(['Track', 'Organize', 'Bill', 'Review'])
    // Nothing is highlighted before the query says something, so Enter still
    // belongs to the form.
    expect(document.querySelector('[data-command-option][aria-selected="true"]')).toBeNull()

    edit(command, 'invo')
    expect(paletteLabels()).toEqual(['Invoices', 'New invoice'])
    expect(
      document.querySelector<HTMLElement>('[data-command-option][aria-selected="true"]')
        ?.textContent,
    ).toBe('Invoices')

    command.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    )
    expect(
      document.querySelector<HTMLElement>('[data-command-option][aria-selected="true"]')
        ?.textContent,
    ).toBe('New invoice')
    expect(command.getAttribute('aria-activedescendant')).toBe(
      document.querySelector<HTMLElement>('[data-command-option][aria-selected="true"]')?.id,
    )

    const assign = vi.spyOn(globalThis.location, 'assign').mockImplementation(() => {})
    try {
      command.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      expect(assign).toHaveBeenCalledWith('/invoices/new')
    } finally {
      assign.mockRestore()
    }
  })

  it('[security] withholds from a member the destinations the nav hides', async () => {
    renderBrowserShell()
    await mountShell(paletteApi(secondIdentity))
    // The premise: the same three guards that hide these from the nav are what
    // the palette is being asked about. Without this the test could pass on a
    // palette that lists nothing at all.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-profile]')?.textContent).toBe('member'),
    )
    expect(navHidden('/approvals')).toBe(true)
    expect(navHidden('/team')).toBe(true)
    // #491 put the three directories behind a gate of the same kind.
    expect(navHidden('/projects')).toBe(true)
    expect(navHidden('/tasks')).toBe(true)
    expect(navHidden('/clients')).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-settings-company-tab]')!.hidden).toBe(true)
    // The activity log names who did what, so it is gated with Company rather
    // than offered to everyone who can reach Settings.
    expect(document.querySelector<HTMLElement>('[data-settings-activity-tab]')!.hidden).toBe(
      true,
    )

    openPalette()
    const labels = paletteLabels()
    expect(labels).not.toContain('Activity log')
    expect(labels).not.toContain('Approvals')
    expect(labels).not.toContain('Team')
    expect(labels).not.toContain('Company settings')
    // The palette needed no second rule to drop the directories: it reads the
    // nav item, which is the whole reason the gate was put there.
    expect(labels).not.toContain('Projects')
    expect(labels).not.toContain('Tasks')
    expect(labels).not.toContain('Clients')
    // And it is a filtered list rather than an empty one.
    expect(labels).toContain('Expenses')
    expect(labels).toContain('Your settings')
  })

  it('[unit] leaves log and go to the command grammar they had', async () => {
    renderBrowserShell()
    const api = paletteApi(identity)
    await mountShell(api)

    const command = openPalette()
    edit(command, 'log 1h northpeak development')
    expect(paletteLabels()).toEqual([])
    expect(document.querySelector('[data-command-empty]')).not.toBeNull()

    document
      .querySelector<HTMLFormElement>('[data-command-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    const entryDialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    await vi.waitFor(() => expect(entryDialog.open).toBe(true))
    expect(entryDialog.dataset.entryContext).toBe('quick-add')
  })
  it('[browser] switches row density from the settings page and remembers it', async () => {
    // The stylesheet has carried `[data-density='compact']` since the shell was
    // built and nothing set the attribute, so the rule matched no document.
    // This is the reachability half: a control that writes it, and a preference
    // that survives the next load.
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())

    const compact = document.querySelector<HTMLButtonElement>(
      '[data-density-choice="compact"]',
    )!
    expect(document.documentElement.dataset.density).toBeUndefined()

    compact.click()

    expect(document.documentElement.dataset.density).toBe('compact')
    expect(compact.getAttribute('aria-pressed')).toBe('true')
    expect(globalThis.localStorage.getItem('ezacto.density')).toBe('compact')

    // The next load reads it back and applies it before anything else paints.
    renderBrowserShell({ view: 'settings-user', preserveStorage: true })
    await mountShell(browserApi())
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(
      document
        .querySelector<HTMLButtonElement>('[data-density-choice="compact"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('[browser #800] text size is chosen on the You page, applied at once, and kept', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())

    const larger = document.querySelector<HTMLButtonElement>('[data-text-size-choice="larger"]')!
    expect(document.documentElement.dataset.textSize).toBeUndefined()
    expect(
      document
        .querySelector<HTMLButtonElement>('[data-text-size-choice="default"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')

    larger.click()

    expect(document.documentElement.dataset.textSize).toBe('larger')
    expect(larger.getAttribute('aria-pressed')).toBe('true')
    expect(globalThis.localStorage.getItem('ezacto.text-size')).toBe('larger')

    // The next load reads it back before anything else paints, like density.
    renderBrowserShell({ view: 'settings-user', preserveStorage: true })
    await mountShell(browserApi())
    expect(document.documentElement.dataset.textSize).toBe('larger')

    // Back to the default removes the attribute rather than naming it.
    document.querySelector<HTMLButtonElement>('[data-text-size-choice="default"]')!.click()
    expect(document.documentElement.dataset.textSize).toBeUndefined()
  })


  it('[browser #539] shows a duration example the account would actually accept', async () => {
    // The served HTML carried a literal "1:30". On a decimal account that is a
    // value the field rejects, so the placeholder was teaching the wrong format
    // to every operator whose organization tracks in decimal.
    renderBrowserShell()
    const decimal = browserApi()
    decimal.timeFormat = 'decimal'
    await mountShell(decimal)
    expect(
      document.querySelector<HTMLInputElement>('[data-entry-duration-input]')?.placeholder,
    ).toBe('1.5')

    renderBrowserShell()
    const clock = browserApi()
    clock.timeFormat = 'hours_minutes'
    await mountShell(clock)
    expect(
      document.querySelector<HTMLInputElement>('[data-entry-duration-input]')?.placeholder,
    ).toBe('1:30')
  })

  it('[browser #497 #506] offers the project and task lists the moment the timer dialog opens', async () => {
    renderBrowserShell()
    await mountShell(browserApi())

    document.querySelector<HTMLButtonElement>('[data-timer-chip]')!.click()

    const projects = [
      ...document.querySelectorAll<HTMLOptionElement>('[data-entry-project-options] option'),
    ].map((node) => node.value)
    const tasks = [
      ...document.querySelectorAll<HTMLOptionElement>('[data-entry-task-options] option'),
    ].map((node) => node.value)
    const project = document.querySelector<HTMLSelectElement>('[data-entry-project]')!

    // Counted before anything is read off them: an empty catalogue would
    // satisfy every assertion below without measuring one.
    expect(projects.length).toBeGreaterThan(0)
    expect(project.value).not.toBe('')
    // The dialog pre-fills a project, so the task list must already be the one
    // for THAT project -- not whatever was computed while the box was empty.
    expect(tasks.length).toBeGreaterThan(0)
  })

  it('[browser #459] applies the theme through the runtime, and keeps documents on the org theme', async () => {
    // The module resolved a stored choice against an organization default and
    // kept the document theme separate, and nothing constructed it -- the shell
    // wrote the name as a literal in three places. A unit test of the module
    // could not catch that: the only thing constructing it was the test.
    renderBrowserShell()

    // Stripped first, deliberately. The served HTML carries the same value the
    // runtime resolves, so leaving the attributes in place lets a shell that
    // never starts the runtime pass by doing nothing -- which is exactly the
    // bug. Blank means only the runtime can put them back.
    document.documentElement.removeAttribute('data-ez-theme')
    const documents = [...document.querySelectorAll<HTMLElement>('[data-document-shell]')]
    expect(documents.length).toBeGreaterThan(0)
    for (const node of documents) node.removeAttribute('data-ez-theme')

    await mountShell(browserApi())

    const applied = document.documentElement.getAttribute('data-ez-theme')
    expect(applied).not.toBeNull()
    expect(Object.hasOwn(themeManifest, applied!)).toBe(true)
    // Every document shell carries the organization's document theme, which is
    // the separation the module exists for: an invoice a client receives must
    // not change because somebody picked a different shell.
    for (const node of documents) {
      expect(node.getAttribute('data-ez-theme')).toBe(defaultTheme)
    }
  })
})

describe('where focus lands when the command bar and the menu open (issue 861)', () => {
  // showModal() focuses the first focusable element in the dialog, and in both
  // of these that was the close button in the header: ⌘K took a Tab before it
  // took a keystroke. happy-dom runs no focusing steps of its own, so these
  // read only what the shell itself does on open.
  const commandDialog = (): HTMLDialogElement =>
    document.querySelector<HTMLDialogElement>('[data-command-dialog]')!
  const commandInput = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('[name="command"]')!
  const pressCommandK = (): void => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }),
    )
  }

  it('[unit] opening the command bar puts focus in the query, from the button and from ⌘K', async () => {
    renderBrowserShell()
    await mountShell(browserApi())

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    expect(commandDialog().open).toBe(true)
    expect(document.activeElement).toBe(commandInput())

    commandDialog().close()
    // Moved off the input first, or the shortcut would pass by finding focus
    // where the button left it.
    commandInput().blur()
    expect(document.activeElement).not.toBe(commandInput())
    pressCommandK()
    expect(commandDialog().open).toBe(true)
    expect(document.activeElement).toBe(commandInput())
  })

  it('[unit] selects what the last use left in the query, so typing replaces it', async () => {
    // The Tab this replaces selected the field's text, so ⌘K-then-type wrote
    // over an old query. Focusing alone would leave the caret after it and
    // append, which reads as "nothing matches" for a query typed correctly.
    renderBrowserShell()
    await mountShell(browserApi())
    pressCommandK()
    edit(commandInput(), 'invo')
    commandDialog().close()

    pressCommandK()
    expect(document.activeElement).toBe(commandInput())
    expect([commandInput().selectionStart, commandInput().selectionEnd]).toEqual([0, 4])
  })

  it('[unit] opening the menu puts focus on its first link, past one a gate hides', async () => {
    renderBrowserShell()
    await mountShell(browserApi())
    const menu = document.querySelector<HTMLDialogElement>('[data-menu-dialog]')!
    const trigger = document.querySelector<HTMLButtonElement>('[data-menu-trigger]')!
    const links = [...menu.querySelectorAll<HTMLAnchorElement>('nav a')]

    trigger.click()
    expect(menu.open).toBe(true)
    expect(document.activeElement).toBe(links[0])
    expect(links[0]!.querySelector('.menu-card-title')?.textContent).toBe('Time')

    // A gate hides a link with `hidden`, and focus() on a link that is not
    // drawn goes nowhere, leaving the close button where showModal() put it.
    menu.close()
    links[0]!.hidden = true
    trigger.click()
    const firstShowing = links.find((link) => !link.hidden)
    expect(firstShowing).toBeDefined()
    expect(firstShowing).not.toBe(links[0])
    expect(document.activeElement).toBe(firstShowing)
  })
})

describe('the search trigger and its key chip (the 2026-10 reskin)', () => {
  it('[unit] writes the command key on Apple platforms and Ctrl everywhere else', () => {
    // Both chords open the bar on every platform; this decides only the label.
    expect(commandShortcutModifier({ platform: 'MacIntel' })).toBe('⌘')
    expect(commandShortcutModifier({ userAgentData: { platform: 'macOS' } })).toBe('⌘')
    expect(
      commandShortcutModifier({
        platform: '',
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      }),
    ).toBe('⌘')
    expect(commandShortcutModifier({ platform: 'Win32' })).toBe('Ctrl ')
    expect(commandShortcutModifier({ userAgentData: { platform: 'Linux' } })).toBe('Ctrl ')
    expect(commandShortcutModifier({})).toBe('Ctrl ')
  })

  it('[browser] fills the chip from the browser it runs in, and opens the bar from it', async () => {
    renderBrowserShell()
    const slot = document.querySelector<HTMLElement>('[data-command-modifier]')!
    // The server leaves it blank: it cannot see the keyboard.
    expect(slot.textContent).toBe('')
    await mountShell(browserApi())
    expect(slot.textContent).toBe(
      commandShortcutModifier(globalThis.navigator as Navigator & PlatformHints),
    )
    const trigger = document.querySelector<HTMLButtonElement>('[data-app-nav] [data-command-trigger]')!
    expect(trigger.getAttribute('aria-label')).toBe('Search and commands')
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K')
    trigger.click()
    expect(document.querySelector<HTMLDialogElement>('[data-command-dialog]')!.open).toBe(true)
    // The query keeps its role and its id inside the new wrapper.
    const query = document.querySelector<HTMLInputElement>('#ez-command')!
    expect(query.closest('.command-query')).not.toBeNull()
    expect(query.getAttribute('role')).toBe('combobox')
    expect(query.getAttribute('aria-controls')).toBe('ez-command-results')
    expect(document.activeElement).toBe(query)
  })
})
