import { describe, expect, it, vi } from 'vitest'
import {
  createShellApi,
  hydratePendingTimesheetDetails,
  invoiceTabs,
  loadShellSnapshot,
  maximumTimeEntryNoteLength,
  navigationDestination,
  palettePlan,
  parseQuickAdd,
  quickAdd,
  renderAppShell,
  renderDataQualityBanner,
  renderDocumentShell,
  runningElapsedSeconds,
  startTimer,
  timeEntryNoteLength,
  TimeEntryNoteValidationError,
  webAssets,
  type ShellApi,
} from '../src/index.js'
import type {
  EzactoClient,
  GeneralResource,
  TimeEntry,
  TimeEntryInput,
  TimeEntryPatch,
  TimesheetSubmission,
  TimesheetSubmissionDetail,
  Whoami,
} from '@ezacto/client'

const timestamp = '2026-08-28T12:00:00.000Z'
const identity: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}
const project: GeneralResource = {
  id: 1,
  name: 'Northpeak',
  code: 'northpeak',
  created_at: timestamp,
  updated_at: timestamp,
}
const task: GeneralResource = {
  id: 1,
  name: 'DevOps',
  created_at: timestamp,
  updated_at: timestamp,
}

const entry = (
  input: TimeEntryInput,
  id: number,
  minimumNoteLength = 0,
): TimeEntry => ({
  id,
  user_id: 1,
  project_id: input.project_id,
  task_id: input.task_id,
  spent_date: input.spent_date ?? '2026-08-28',
  seconds: input.seconds ?? 0,
  is_running: input.seconds === undefined,
  timer_started_at: input.seconds === undefined ? timestamp : null,
  notes: input.notes ?? null,
  billable: true,
  budgeted: false,
  approval_status: 'unsubmitted',
  is_billed: false,
  is_locked: false,
  minimum_note_length: minimumNoteLength,
  created_at: timestamp,
  updated_at: timestamp,
})

const memoryApi = (
  minimumNoteLength = 0,
): ShellApi & { entries: TimeEntry[] } => {
  const entries: TimeEntry[] = []
  return {
    entries,
    whoami: vi.fn(async () => identity),
    signIn: vi.fn(async () => ({
      status: 'authenticated' as const,
      user_id: 1,
      profile: 'administrator' as const,
      manager_grants: [],
    })),
    logoutCurrentSession: vi.fn(async () => ({
      id: 1,
      created_at: timestamp,
      last_seen_at: timestamp,
      idle_expires_at: timestamp,
      absolute_expires_at: timestamp,
      revoked_at: timestamp,
      revocation_reason: 'user_revoked' as const,
      current: false,
    })),
    listProjects: vi.fn(async () => ({
      data: [project],
      page: { next_cursor: null },
    })),
    listTasks: vi.fn(async () => ({
      data: [task],
      page: { next_cursor: null },
    })),
    listTimeEntryOptions: vi.fn(async () => [
      {
        project_id: 1,
        task_id: 1,
        minimum_note_length: minimumNoteLength,
      },
    ]),
    getTimeEntrySettings: vi.fn(async () => ({
      time_entry_mode: 'duration' as const,
      time_format: 'decimal' as const,
      clock: '12h' as const,
      week_start_day: 'monday' as const,
    })),
    listTimeEntries: vi.fn(async (query) =>
      query.is_running === true ? entries.filter((item) => item.is_running) : [...entries],
    ),
    createTimeEntry: vi.fn(async (input) => {
      const created = entry(input, entries.length + 1, minimumNoteLength)
      entries.push(created)
      return created
    }),
    updateTimeEntry: vi.fn(async (id, patch: TimeEntryPatch) => {
      const current = entries.find((item) => item.id === id)
      if (current === undefined) throw new Error('entry not found')
      const updated = { ...current, ...patch, updated_at: timestamp }
      entries.splice(entries.indexOf(current), 1, updated)
      return updated
    }),
    deleteTimeEntry: vi.fn(async (id) => {
      const index = entries.findIndex((item) => item.id === id)
      if (index === -1) throw new Error('entry not found')
      entries.splice(index, 1)
    }),
    stopTimeEntry: vi.fn(async (id) => {
      const current = entries.find((item) => item.id === id)
      if (current === undefined) throw new Error('entry not found')
      const stopped = { ...current, is_running: false, seconds: 60 }
      entries.splice(entries.indexOf(current), 1, stopped)
      return stopped
    }),
  }
}

describe('S-1 through S-5 application shell', () => {
  it('[unit] maps invoice browse operations to the generated client', async () => {
    const listInvoices = vi.fn(async () => ({
      data: [],
      links: {},
      page: { next_cursor: null },
    }))
    const getInvoice = vi.fn(async () => ({ data: {}, links: {} }))
    const listInvoiceMessages = vi.fn(async () => ({ data: [], links: {} }))
    const listInvoicePayments = vi.fn(async () => ({ data: [], links: {} }))
    const api = createShellApi({
      listInvoices,
      getInvoice,
      listInvoiceMessages,
      listInvoicePayments,
    } as unknown as EzactoClient)
    const signal = new AbortController().signal

    await api.listInvoices!('opaque-cursor', signal)
    await api.getInvoice!(7, signal)
    await api.listInvoiceMessages!(7, signal)
    await api.listInvoicePayments!(7, signal)

    expect(listInvoices).toHaveBeenCalledWith({
      query: { cursor: 'opaque-cursor', per_page: 50 },
      signal,
    })
    expect(getInvoice).toHaveBeenCalledWith({ id: 7, signal })
    expect(listInvoiceMessages).toHaveBeenCalledWith({ id: 7, signal })
    expect(listInvoicePayments).toHaveBeenCalledWith({ id: 7, signal })
  })

  it('[unit] requests only one bounded approval queue page', async () => {
    const listPendingTimesheetSubmissions = vi.fn(async () => ({
      data: [],
      page: { next_cursor: 'ignored-because-the-view-is-bounded' },
    }))
    const api = createShellApi({ listPendingTimesheetSubmissions } as unknown as EzactoClient)

    await api.listPendingTimesheetSubmissions!()

    expect(listPendingTimesheetSubmissions).toHaveBeenCalledTimes(1)
    expect(listPendingTimesheetSubmissions).toHaveBeenCalledWith({
      query: { per_page: 50 },
    })
  })

  it('[unit] bounds and concurrency-limits approval detail hydration and drops stale rows', async () => {
    const summaries = Array.from({ length: 55 }, (_, index) => ({
      id: index + 1,
      status: 'submitted',
    })) as TimesheetSubmission[]
    let active = 0
    let maximumActive = 0
    const getSubmission = vi.fn(async (id: number) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active--
      return {
        id,
        status: id === 7 ? 'approved' : 'submitted',
        entries: [],
      } as unknown as TimesheetSubmissionDetail
    })

    const details = await hydratePendingTimesheetDetails(summaries, getSubmission)

    expect(getSubmission).toHaveBeenCalledTimes(50)
    expect(maximumActive).toBeLessThanOrEqual(4)
    expect(details).toHaveLength(49)
    expect(details.some((detail) => detail.id === 7)).toBe(false)
  })

  it('[unit] lets a section supply its own tab strip, and leaves Time its own', () => {
    // The strip was hardcoded into the shell, so exactly one section could have
    // sub-navigation and no other could have any.
    const withTabs = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-list',
      tabs: [
        { label: 'Overview', href: '/invoices', current: true },
        { label: 'Recurring', href: '/invoices/recurring' },
      ],
    })
    expect(withTabs).toContain('<a href="/invoices" aria-current="page">Overview</a>')
    expect(withTabs).toContain('<a href="/invoices/recurring">Recurring</a>')
    // Not Time's strip: the browser rewrites aria-current on that one from the
    // ?view= parameter, which would strip it off every tab here.
    expect(withTabs).not.toContain('data-time-views')

    const timeShell = renderAppShell({ environment: 'test', release: 'abcdef012345' })
    expect(timeShell).toContain('data-time-views')
    expect(timeShell).toContain('>Week</a>')

    // A section that declares no tabs renders no strip at all rather than an
    // empty bar.
    const noTabs = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Clients',
      view: 'client-list',
      tabs: [],
    })
    expect(noTabs).not.toContain('class="tabstrip"')
  })

  it('[acceptance] gives Invoices four destinations and a labelled pane behind each', () => {
    // Invoices was one flat list while /api/v1/recurring-invoices,
    // /api/v1/retainers and the sender-identity endpoints sat behind nothing at
    // all. The strip ships ahead of the screens on purpose: a labelled empty
    // pane says where that work will live, an absent section says nothing.
    const stripOf = (html: string): string =>
      /<nav class="tabstrip"[^>]*>(.*?)<\/nav>/su.exec(html)?.[1] ?? ''

    const overview = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-list',
      tabs: invoiceTabs('invoice-list'),
    })
    expect(stripOf(overview)).toBe(
      '<a href="/invoices" aria-current="page">Overview</a>' +
        '<a href="/invoices/recurring">Recurring</a>' +
        '<a href="/invoices/retainers">Retainers</a>' +
        '<a href="/invoices/configure">Configure</a>',
    )

    const recurring = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-recurring',
      tabs: invoiceTabs('invoice-recurring'),
    })
    // One tab is current, and it is the one whose pane is showing.
    expect(stripOf(recurring)).toContain(
      '<a href="/invoices/recurring" aria-current="page">Recurring</a>',
    )
    expect(stripOf(recurring).match(/aria-current/gu)).toHaveLength(1)
    expect(recurring).toContain('data-invoice-recurring-page>')
    expect(recurring).toContain('Recurring invoices are not built yet')
    expect(recurring).toContain('data-invoice-retainers-page hidden>')
    expect(recurring).toContain('data-invoice-list-page hidden>')

    const retainers = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-retainers',
      tabs: invoiceTabs('invoice-retainers'),
    })
    expect(retainers).toContain('data-invoice-retainers-page>')
    // The pane no longer admits it is empty: it is the list and the detail the
    // controller fills in, and both are present in the served document.
    expect(retainers).not.toContain('Retainers are not built yet')
    expect(retainers).toContain('data-retainer-list-view')
    expect(retainers).toContain('data-retainer-detail-view hidden')
    expect(retainers).toContain('data-retainer-ledger')

    const configure = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-configure',
      tabs: invoiceTabs('invoice-configure'),
    })
    expect(configure).toContain('data-invoice-configure-page>')
    expect(configure).toContain('Invoice configuration is not built yet')
  })

  it('[unit] draws the shell marks as inline icons rather than as glyphs', () => {
    const html = renderAppShell({ environment: 'test', release: 'abcdef012345' })
    // The stepper was the literal `←`/`→` characters, which are whatever the
    // reader's font decides they are and cannot be sized or coloured with the
    // button around them.
    expect(html).not.toContain('←')
    expect(html).not.toContain('→')
    expect(html).toContain('data-icon="chevron"')
    expect(html).toContain('data-icon="magnifier"')
    // No icon font and no second request: the geometry is in the document the
    // worker already serves.
    expect(html).not.toMatch(/<link[^>]+(?:icon|glyph)[^>]*>/u)
    expect(html).not.toContain('@font-face')

    // Every mark in the shell decorates a control that already names itself,
    // so every one of them is hidden from the reader. A shell that announced
    // "image" beside each stepper would be worse than the glyphs it replaced.
    const marks = html.match(/<svg class="ez-icon"[^>]*>/gu) ?? []
    expect(marks.length).toBeGreaterThanOrEqual(6)
    expect(marks.filter((mark) => !mark.includes('aria-hidden="true"'))).toEqual([])
    expect(marks.filter((mark) => mark.includes('role="img"'))).toEqual([])

    // …which only holds while the controls really do name themselves.
    expect(html).toContain('data-week-previous data-auth-action disabled aria-label="Previous week"')
    expect(html).toContain('data-week-next data-auth-action disabled aria-label="Next week"')
    expect(html).toContain('data-day-previous data-auth-action disabled aria-label="Previous day"')
    expect(html).toContain('data-day-next data-auth-action disabled aria-label="Next day"')
    expect(html).toContain('aria-label="Search and commands (⌘K)"')
  })

  it('[e2e:track-week] keeps the global timer in desktop and phone shell CSS', () => {
    const html = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
    })
    expect(html).toContain('data-timer-chip')
    expect(html).toContain('data-timer-dialog')
    expect(html).toContain('data-menu-dialog')
    expect(html).toContain('data-week-grid')
    expect(html).toContain('data-day-list')
    expect(html).toContain('data-copy-last-week')
    expect(html).toContain('data-add-row-trigger')
    expect(html).toContain('data-note-dialog')
    expect(html).toContain('data-timer-note')
    expect(html).toContain('<form data-timer-form novalidate data-entry-form data-note-form>')
    expect(html.match(/data-entry-form/gu)).toHaveLength(1)
    expect(html).toContain('data-note-hint')
    expect(html).toContain('maxlength="10000"')
    expect(html).not.toContain('maxlength="65535"')
    expect(html).toContain('data-sign-in-form')
    expect(html).toContain('data-auth-gateway data-state="checking"')
    expect(html).toContain('data-authenticated-shell hidden inert')
    expect(html).toContain('data-session-check-overlay role="status"')
    expect(html).toContain('data-session-check-overlay role="status" aria-live="polite" aria-atomic="true" hidden')
    expect(html).toContain('method="post" action="/auth/sign-in"')
    expect(html).toContain('autocomplete="username"')
    expect(html).toContain('autocomplete="current-password"')
    expect(html).toContain('data-current-identity')
    expect(html).toContain('data-logout')
    expect(html).toContain('name="viewport"')
    expect(webAssets.stylesheet).toContain('@media (max-width: 720px)')
    expect(webAssets.stylesheet).toContain('.timer-chip {')
    expect(webAssets.stylesheet).toContain('.auth-gateway {')
    expect(webAssets.stylesheet).toContain('.session-check-overlay {')
    expect(webAssets.stylesheet).not.toMatch(/\.timer-chip\s*\{[^}]*display:\s*none/su)
    expect(webAssets.javascript).toContain('credentials:"same-origin"')
  })

  it('[security] uses a cookie-presence hint only to show an inert shell under a session-check overlay', () => {
    const html = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      sessionCookiePresent: true,
    })

    expect(html).toContain('data-auth-state="checking"')
    expect(html).toContain('data-auth-gateway data-state="checking"')
    expect(html).toMatch(/data-auth-gateway[^>]+ hidden>/u)
    expect(html).toContain(
      'data-session-check-overlay role="status" aria-live="polite" aria-atomic="true">',
    )
    expect(html).toContain('data-authenticated-shell inert aria-busy="true"')
    expect(html).not.toContain('data-authenticated-shell hidden inert')
    expect(html).toContain('data-auth-action disabled')
  })

  it('[e2e:phone-week] swaps the seven-day table for a touch-sized day switcher', () => {
    const html = renderAppShell({ environment: 'test', release: 'abcdef012345' })
    expect(html).toContain('class="day-switcher"')
    expect(html).toContain('data-day-previous')
    expect(html).toContain('data-day-next')
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.week-grid-wrap \{[\s\S]*display: none;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.day-list \{[\s\S]*display: block;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /\.week-actions button,[\s\S]*\.day-switcher button \{[\s\S]*min-height: 44px;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.auth-gateway \{[\s\S]*grid-template-columns: 1fr;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /\.sign-in-form input \{[\s\S]*min-height: 44px;/u,
    )
  })

  it('[acceptance] renders only configured fixed-path OIDC providers with password fallback', () => {
    const configured = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      signInProviders: ['google'],
    })
    expect(configured).toContain('data-oidc-provider="google"')
    expect(configured).toContain('href="/auth/oidc/google"')
    expect(configured).toContain('Continue with Google')
    expect(configured).toContain('method="post" action="/auth/sign-in"')
    expect(configured).not.toContain('accounts.google.com')
    expect(configured).not.toContain('client_secret')

    const unavailable = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
    })
    expect(unavailable).not.toContain('data-oidc-provider')
    expect(unavailable).not.toContain('data-oidc-entry')
    expect(unavailable).not.toContain('Single sign-on is not available')
    expect(unavailable).toContain('Sign in to ezacto')
    expect(webAssets.stylesheet).toMatch(/\.oidc-sign-in \{[\s\S]*min-height: 44px;/u)
    expect(webAssets.stylesheet).toMatch(/\.oidc-entry \{[\s\S]*display: grid;/u)
  })

  it('[unit] resolves K-bar navigation and computes a live timer counter', () => {
    const everything = () => true
    expect(navigationDestination('go reports', everything)).toBe('/reports')
    expect(navigationDestination('go tasks', everything)).toBe('/tasks')
    expect(navigationDestination('GO time', everything)).toBe('/')
    expect(navigationDestination('log 2h northpeak devops', everything)).toBeNull()
    const running = entry({ project_id: 1, task_id: 1 }, 1)
    expect(runningElapsedSeconds(running, new Date('2026-08-28T12:01:30.000Z'))).toBe(90)
  })

  it('[security] the go grammar reaches only what the palette offers', () => {
    // The results list and the typed `go` grammar are one dialog over one
    // table. Gating only the list left a member shown no Approvals entry who
    // could still type "go approvals" into the same input and land there.
    const withheld = new Set(['Approvals', 'Team', 'Company settings'])
    const offered = (destination: { label: string }): boolean =>
      !withheld.has(destination.label)

    expect(navigationDestination('go approvals', offered)).toBeNull()
    expect(navigationDestination('go team', offered)).toBeNull()
    expect(navigationDestination('go company settings', offered)).toBeNull()
    // What the profile may reach is unaffected, so this is a gate and not a
    // blanket refusal.
    expect(navigationDestination('go reports', offered)).toBe('/reports')
    expect(navigationDestination('go time', offered)).toBe('/')
  })

  it('[unit] files record hits under their own headings, after the commands', () => {
    // Track / Organize / Bill / Review name what you are trying to do. A client
    // is not a thing you are trying to do, so filing one under Organize would
    // make those four headings mean two things at once.
    // The query has to match a command as well as the records, or the ordering
    // claim is vacuous -- with no command sections present, records are first
    // whether or not the code puts them last.
    const sections = palettePlan('report', () => true, [
      { kind: 'client', label: 'Reporting Co', href: '/clients/4' },
      { kind: 'project', label: 'Report rebuild', href: '/projects/9' },
    ])

    const headings = sections.map((section) => section.group)
    const commandHeadings = ['Track', 'Organize', 'Bill', 'Review']
    expect(headings.some((heading) => commandHeadings.includes(heading))).toBe(true)
    expect(headings).toContain('Clients')
    expect(headings).toContain('Projects')
    // Records come last: a typed query is more often reaching for a screen than
    // for a row, and a screen the person can name should not be pushed down the
    // list by rows that merely share a substring.
    const lastCommand = headings.reduce(
      (last, heading, index) => (commandHeadings.includes(heading) ? index : last),
      -1,
    )
    const firstRecord = headings.findIndex(
      (heading) => !commandHeadings.includes(heading),
    )
    expect(lastCommand).toBeLessThan(firstRecord)
    const clients = sections.find((section) => section.group === 'Clients')
    expect(clients?.destinations).toEqual([
      { kind: 'client', label: 'Reporting Co', href: '/clients/4' },
    ])
  })

  it('[unit] offers no records for an empty query', () => {
    // An open palette that has been typed into and then cleared must not keep
    // showing the rows the last word found.
    const sections = palettePlan('', () => true, [
      { kind: 'client', label: 'Northpeak', href: '/clients/4' },
    ])

    expect(sections.map((section) => section.group)).not.toContain('Clients')
    expect(sections.flatMap((section) => section.destinations)).not.toContainEqual(
      expect.objectContaining({ href: '/clients/4' }),
    )
  })

  it('[security] record hits do not bypass the destination gate', () => {
    // The gate withholds screens, not rows -- but a record section must not
    // become a second way to reach a withheld screen either, so a gate that
    // hides everything still leaves the record headings and nothing else.
    const sections = palettePlan('north', () => false, [
      { kind: 'client', label: 'Northpeak', href: '/clients/4' },
    ])

    expect(sections.map((section) => section.group)).toEqual(['Clients'])
    expect(sections.flatMap((section) => section.destinations)).toEqual([
      { kind: 'client', label: 'Northpeak', href: '/clients/4' },
    ])
  })

  it('[unit] creates an entry and the refreshed week snapshot reflects it', async () => {
    const api = memoryApi()
    expect(parseQuickAdd('log 2h northpeak devops')).toEqual({
      seconds: 7_200,
      project: 'northpeak',
      task: 'devops',
    })

    await quickAdd(api, 'log 2h northpeak devops shipped', new Date(timestamp))
    const snapshot = await loadShellSnapshot(api, new Date(timestamp))

    expect(api.createTimeEntry).toHaveBeenCalledWith({
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-28',
      seconds: 7_200,
      notes: 'shipped',
    })
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]).toMatchObject({
      project_label: 'Northpeak',
      task_label: 'DevOps',
      seconds: 7_200,
    })
  })

  it('[unit] enforces the exact assignment note policy for quick-add and timers', async () => {
    const api = memoryApi(5)

    await expect(
      quickAdd(api, 'log 2h northpeak devops no', new Date(timestamp)),
    ).rejects.toBeInstanceOf(TimeEntryNoteValidationError)
    await expect(
      startTimer(
        api,
        'northpeak',
        'devops',
        undefined,
        'four',
      ),
    ).rejects.toMatchObject({ minimumLength: 5 })
    expect(api.createTimeEntry).not.toHaveBeenCalled()

    await quickAdd(api, 'log 2h northpeak devops shipped', new Date(timestamp))
    await startTimer(
      api,
      'northpeak',
      'devops',
      undefined,
      'timer notes',
    )
    expect(api.createTimeEntry).toHaveBeenLastCalledWith({
      project_id: 1,
      task_id: 1,
      notes: 'timer notes',
    })
    expect(timeEntryNoteLength('  🚀🚀  ')).toBe(2)

    api.listTimeEntryOptions = vi.fn(async () => [])
    await expect(
      quickAdd(api, 'log 1h northpeak devops enough detail', new Date(timestamp)),
    ).rejects.toThrow('combination is not available')
  })

  it('[unit] aligns the note maximum with the API UTF-16 request limit', async () => {
    const api = memoryApi()
    const exact = 'a'.repeat(maximumTimeEntryNoteLength)
    await quickAdd(api, `log 1h northpeak devops ${exact}`, new Date(timestamp))
    expect(api.createTimeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ notes: exact }),
    )

    const overInUtf16 = '😀'.repeat(5_001)
    expect(timeEntryNoteLength(overInUtf16)).toBe(5_001)
    await expect(
      quickAdd(
        api,
        `log 1h northpeak devops ${overInUtf16}`,
        new Date(timestamp),
      ),
    ).rejects.toThrow('cannot exceed 10,000 characters')
  })

  it('[unit] renders an escaped DV-11 fix deep-link and rejects external targets', () => {
    const banner = renderDataQualityBanner({
      message: 'Two people are missing <rates>.',
      fixHref: '/settings/team?filter=missing-rates',
      fixLabel: 'Add missing rates',
    })
    expect(banner).toContain('Two people are missing &lt;rates&gt;.')
    expect(banner).toContain('href="/settings/team?filter=missing-rates"')
    expect(() =>
      renderDataQualityBanner({
        message: 'Unsafe',
        fixHref: 'https://example.test',
        fixLabel: 'Leave',
      }),
    ).toThrow('deep links must be same-origin absolute paths')
  })

  it('[unit] renders money artifacts in the chromeless pinned document shell', () => {
    const html = renderDocumentShell('Invoice <123>', '<script>unsafe()</script>')
    expect(html).toContain('data-document-shell')
    expect(html).toContain('data-ez-theme="precision"')
    expect(html).toContain('Invoice &lt;123&gt;')
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
    expect(html).not.toContain('<script>unsafe()</script>')
  })

  it('[acceptance] renders honest invoice list and pinned detail workspaces', () => {
    const list = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-list',
    })
    const detail = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-detail',
    })
    const generation = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Invoices',
      view: 'invoice-generation',
    })

    expect(list).toContain('data-invoice-list-page')
    expect(list).toContain('data-invoice-list aria-label="Invoices"')
    // The Invoices item now carries the money gate the browser opens for a
    // profile that may read invoices, so the marked-current assertion reads
    // across it rather than around it.
    expect(list).toContain('href="/invoices" data-money-nav hidden aria-current="page"')
    expect(detail).toContain('data-invoice-detail-page')
    expect(detail).toContain('data-invoice-document data-document-shell')
    expect(detail).toContain('data-ez-theme="precision"')
    expect(detail).toContain('data-invoice-detail-lines')
    expect(detail).toContain('data-invoice-line-add')
    expect(detail).toContain('data-invoice-line-dialog')
    expect(detail).toContain('data-invoice-line-delete-dialog')
    expect(detail).toContain('data-invoice-detail-payments')
    expect(detail).toContain('data-invoice-payment-record')
    expect(detail).toContain('data-invoice-payment-dialog')
    expect(detail).toContain('data-invoice-payment-delete-dialog')
    expect(detail).toContain('No email or thank-you message will be sent.')
    expect(detail).toContain('data-invoice-detail-messages')
    // One Send dialog, not two: the state change and the email are the same
    // control now, with the email behind a checkbox and its own confirmation.
    expect(detail).not.toContain('data-invoice-deliver>')
    expect(detail).not.toContain('data-invoice-delivery-dialog')
    expect(detail).toContain('data-invoice-send')
    expect(detail).toContain('data-invoice-composer-deliver-toggle')
    expect(detail).toContain('Also deliver by email')
    expect(detail).toContain('data-invoice-composer-confirm')
    // What the client actually receives: the lines, and still no PDF.
    expect(detail).toContain("It lists this invoice's line items; no PDF is attached")
    expect(detail).toContain('data-invoice-reminder-line')
    expect(detail).toContain('data-invoice-composer-dialog')
    expect(detail).toContain('%invoice_number%')
    // The verbs invoiceStateLabel could already render and no operator could
    // reach: the overflow issues all four, destructive ones as red text.
    expect(detail).toContain('data-invoice-overflow-toggle')
    expect(detail).toContain('data-invoice-transition="write_off"')
    expect(detail).toContain('data-invoice-transition="cancel"')
    expect(detail).toContain('data-invoice-transition="draft"')
    expect(detail).toContain('data-invoice-transition="reopen"')
    expect(detail).toContain('data-invoice-transition-dialog')
    expect(detail).toMatch(
      /class="invoice-overflow-item invoice-overflow-destructive"[^>]*data-invoice-transition="write_off"/u,
    )
    expect(detail).toMatch(
      /class="invoice-overflow-item invoice-overflow-destructive"[^>]*data-invoice-transition="cancel"/u,
    )
    expect(generation).toContain('data-generated-invoice-link')
    expect(generation).toContain('The draft is saved and ready to review.')
    expect(detail).not.toMatch(/>Send<|Download PDF|Send reminder/u)
    expect(detail).not.toMatch(/name="(?:provider|reference|send_thank_you)"/u)
    expect(webAssets.stylesheet).toContain('.invoice-document {')
    expect(webAssets.stylesheet).toContain('.invoice-payment-dialog-actions {')
    expect(webAssets.stylesheet).toContain('.invoice-line-dialog {')
    expect(webAssets.stylesheet).toContain('.invoice-line-actions {')
    expect(webAssets.stylesheet).toContain('.invoice-load-more {')
    // Red text, never a red fill: the destructive rules set a colour and no
    // background, which is what keeps them off the AA filled-label bar.
    expect(webAssets.stylesheet).toContain('.invoice-overflow-menu {')
    expect(webAssets.stylesheet).toMatch(
      /\.invoice-document-actions \.invoice-overflow-destructive,\n\.invoice-payment-dialog-actions \.invoice-destructive-action \{\n {2}color: var\(--ez-red\);/u,
    )
  })

  it('[acceptance] renders project list and detail workspaces without server-side restricted fields', () => {
    const list = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Projects',
      view: 'project-list',
    })
    const detail = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      activeSection: 'Projects',
      view: 'project-detail',
    })

    expect(list).toContain('data-project-list-page')
    expect(list).toContain('data-project-client-filter')
    expect(list).toContain('href="/projects" aria-current="page"')
    expect(detail).toContain('data-project-detail-page')
    expect(detail).toContain('data-project-task-assignments')
    expect(detail).toContain('data-project-attachment-form hidden')
    expect(detail).toContain('<div class="project-form-body" data-project-form-body></div>')
    expect(detail).not.toContain('name="hourly_rate_cents"')
    expect(detail).not.toContain('name="cost_budget_cents"')
    expect(webAssets.stylesheet).toContain('.project-detail {')
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.project-detail,[\s\S]*grid-template-columns: 1fr;/u,
    )
  })
})
