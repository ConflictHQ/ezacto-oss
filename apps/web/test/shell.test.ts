import { describe, expect, it, vi } from 'vitest'
import {
  createShellApi,
  hydratePendingTimesheetDetails,
  loadShellSnapshot,
  maximumTimeEntryNoteLength,
  navigationDestination,
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
    expect(navigationDestination('go reports')).toBe('/reports')
    expect(navigationDestination('go tasks')).toBe('/tasks')
    expect(navigationDestination('GO time')).toBe('/')
    expect(navigationDestination('log 2h northpeak devops')).toBeNull()
    const running = entry({ project_id: 1, task_id: 1 }, 1)
    expect(runningElapsedSeconds(running, new Date('2026-08-28T12:01:30.000Z'))).toBe(90)
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
    expect(list).toContain('href="/invoices" aria-current="page"')
    expect(detail).toContain('data-invoice-detail-page')
    expect(detail).toContain('data-invoice-document data-document-shell')
    expect(detail).toContain('data-ez-theme="precision"')
    expect(detail).toContain('data-invoice-detail-lines')
    expect(detail).toContain('data-invoice-detail-payments')
    expect(detail).toContain('data-invoice-payment-record')
    expect(detail).toContain('data-invoice-payment-dialog')
    expect(detail).toContain('data-invoice-payment-delete-dialog')
    expect(detail).toContain('No email or thank-you message will be sent.')
    expect(detail).toContain('data-invoice-detail-messages')
    expect(generation).toContain('data-generated-invoice-link')
    expect(generation).toContain('The draft is saved and ready to review.')
    expect(detail).not.toMatch(/>Send<|Download PDF|Send reminder/u)
    expect(detail).not.toMatch(/name="(?:provider|reference|send_thank_you)"/u)
    expect(webAssets.stylesheet).toContain('.invoice-document {')
    expect(webAssets.stylesheet).toContain('.invoice-payment-dialog-actions {')
    expect(webAssets.stylesheet).toContain('.invoice-load-more {')
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
