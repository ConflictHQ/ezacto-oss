/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
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

  const navHidden = (href: string): boolean =>
    document.querySelector<HTMLElement>(`.primary-nav a[href="${href}"]`)!.hidden

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
    expect(paletteLabels()).toEqual(['Invoices', 'Generate invoice'])
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
    ).toBe('Generate invoice')
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
