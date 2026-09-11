/** @vitest-environment happy-dom */

import type {
  AuthPrincipal,
  Invoice,
  Session,
  TeamPerson,
  TimeEntry,
  TimesheetSubmission,
  UninvoicedReport,
  Whoami,
} from '@ezacto/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountShell } from '../src/shell/browser.js'
import { renderAppShell, type ShellApi } from '../src/index.js'
import { localDate, weekRange } from '../src/shell/model.js'
import { uninvoicedWindow } from '../src/dashboard/model.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const week = weekRange(localDate(), 'monday')

const identity = (profile: Whoami['profile']): Whoami => ({
  user_id: 4,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

const principal = (profile: Whoami['profile']): AuthPrincipal => ({
  status: 'authenticated',
  user_id: 4,
  profile,
  manager_grants: [],
})

const session: Session = {
  id: 1,
  created_at: timestamp,
  last_seen_at: timestamp,
  idle_expires_at: timestamp,
  absolute_expires_at: timestamp,
  revoked_at: timestamp,
  revocation_reason: 'user_revoked',
  current: false,
}

const entry = (seconds: number): TimeEntry => ({
  id: 1,
  user_id: 4,
  project_id: 1,
  task_id: 1,
  spent_date: week.from,
  seconds,
  is_running: false,
  timer_started_at: null,
  started_time: null,
  ended_time: null,
  notes: null,
  billable: true,
  budgeted: false,
  approval_status: 'unsubmitted',
  is_billed: false,
  is_locked: false,
  minimum_note_length: 0,
  created_at: timestamp,
  updated_at: timestamp,
})

const invoice = (overrides: Partial<Invoice>): Invoice =>
  ({
    id: 1,
    client_id: 1,
    created_by_user_id: 4,
    number: 'INV-1',
    subject: null,
    purchase_order: null,
    notes: null,
    currency: 'USD',
    issue_date: '2020-01-01',
    due_date: '2020-02-01',
    payment_terms: 'net_30',
    state: 'open',
    version: 1,
    close_reason: null,
    close_write_off_cents: 0,
    sent_at: timestamp,
    paid_at: null,
    paid_date: null,
    closed_at: null,
    period_start: null,
    period_end: null,
    project_id: null,
    retainer_id: null,
    recurring_invoice_id: null,
    estimate_id: null,
    reminder_policy: null,
    tax_rate_ppm: null,
    tax2_rate_ppm: null,
    discount_rate_ppm: null,
    amount_cents: 100_000,
    due_amount_cents: 100_000,
    tax_amount_cents: 0,
    tax2_amount_cents: 0,
    discount_amount_cents: 0,
    written_off_cents: 0,
    payment_options: [],
    reference_token: null,
    created_at: timestamp,
    updated_at: timestamp,
    line_items: [],
    ...overrides,
  }) as Invoice

/**
 * An invoice book served the way the real endpoint serves one: ascending by id,
 * a page at a time, oldest first.
 */
const pagedInvoices = (pages: readonly (readonly Invoice[])[]) =>
  vi.fn(async (cursor?: string) => {
    const index = cursor === undefined ? 0 : Number(cursor)
    return {
      data: pages[index] ?? [],
      page: { next_cursor: index + 1 < pages.length ? String(index + 1) : null },
    }
  })

const submission = (id: number): TimesheetSubmission => ({
  id,
  user_id: id,
  user_name: `Person ${id}`,
  period_start: week.from,
  period_end: week.to,
  status: 'submitted',
  origin: 'native',
  source_status: null,
  source_observed_at: null,
  submitted_by_user_id: id,
  submitted_at: timestamp,
  reviewed_by_user_id: null,
  reviewed_at: null,
  rejection_reason: null,
  version: 0,
  entry_count: 1,
  expense_count: 0,
  total_seconds: 3_600,
  billable_seconds: 3_600,
  nonbillable_seconds: 0,
  created_at: timestamp,
  updated_at: timestamp,
})

const person = (weeklyCapacity: number): TeamPerson =>
  ({
    id: 4,
    first_name: 'Ada',
    last_name: 'Byron',
    email: 'ada@example.test',
    telephone: null,
    employee_id: null,
    timezone: 'UTC',
    is_contractor: false,
    is_active: true,
    has_access_to_all_future_projects: true,
    weekly_capacity: weeklyCapacity,
    profile: 'administrator',
    is_owner: true,
    avatar_url: null,
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    roles: [],
    departments: [],
    project_assignments: [],
    notifications: {
      delivery_active: false,
      daily_reminder_enabled: false,
      reminder_time: null,
      reminder_days: [],
      channels: { email: false, desktop: false, slack: false },
      include_in_team_reminders: false,
      weekly_digest: false,
      notify_project_deleted: false,
      updated_at: timestamp,
    },
  }) as TeamPerson

const uninvoicedReport = (withMoney: boolean): UninvoicedReport => ({
  from: uninvoicedWindow(localDate()).from,
  to: uninvoicedWindow(localDate()).to,
  client_id: null,
  project_id: null,
  totals: [
    {
      currency: 'USD',
      rounded_seconds: 36_000,
      time_entry_count: 4,
      unpriced_time_entry_count: 0,
      expense_count: 0,
      ...(withMoney ? { time_cents: 125_000, expense_cents: 0, total_cents: 125_000 } : {}),
    },
  ],
  projects: [],
})

const dashboardApi = (
  profile: Whoami['profile'],
  overrides: Partial<ShellApi> = {},
): ShellApi => ({
  whoami: vi.fn(async () => identity(profile)),
  signIn: vi.fn(async () => principal(profile)),
  logoutCurrentSession: vi.fn(async () => session),
  listProjects: vi.fn(async () => ({ data: [], page: { next_cursor: null } })),
  listTasks: vi.fn(async () => ({ data: [], page: { next_cursor: null } })),
  listTimeEntryOptions: vi.fn(async () => []),
  getTimeEntrySettings: vi.fn(async () => ({
    time_entry_mode: 'duration' as const,
    time_format: 'decimal' as const,
    clock: '12h' as const,
    week_start_day: 'monday' as const,
  })),
  listTimeEntries: vi.fn(async (query) => (query.is_running === true ? [] : [entry(10_800)])),
  createTimeEntry: vi.fn(),
  updateTimeEntry: vi.fn(),
  deleteTimeEntry: vi.fn(),
  stopTimeEntry: vi.fn(),
  listTimesheetSubmissions: vi.fn(async () => []),
  ...overrides,
})

const renderDashboard = (): void => {
  window.history.replaceState(null, '', '/dashboard')
  globalThis.localStorage.clear()
  globalThis.sessionStorage.clear()
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'dashboard-test',
      activeSection: 'Home',
      view: 'dashboard',
    })
      .replace(
        / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
        '',
      )
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const cardKeys = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-dashboard-cards] [data-dashboard-card]')]
    .filter((card) => !card.hidden)
    .map((card) => card.dataset.dashboardCard ?? '')

const figure = (key: string): string =>
  document
    .querySelector<HTMLElement>(`[data-dashboard-card="${key}"] [data-dashboard-figure]`)
    ?.textContent ?? ''

const detail = (key: string): string =>
  document
    .querySelector<HTMLElement>(`[data-dashboard-card="${key}"] [data-dashboard-detail]`)
    ?.textContent ?? ''

const note = (key: string): string => {
  const element = document.querySelector<HTMLElement>(
    `[data-dashboard-card="${key}"] [data-dashboard-note]`,
  )
  return element === null || element.hidden ? '' : (element.textContent ?? '')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('home dashboard', () => {
  it('[security] withholds every company figure from a member, and never asks for one', async () => {
    // The premise of the whole screen: a member must not learn the company's
    // uninvoiced total or its receivables from a card. Not by reading it, and
    // not by the request going out and being refused -- a card that asks and
    // then apologises has still told the reader the number exists.
    const getUninvoicedReport = vi.fn(async () => uninvoicedReport(true))
    const listInvoices = vi.fn(async () => ({
      data: [invoice({})],
      page: { next_cursor: null },
    }))
    const listPendingTimesheetSubmissions = vi.fn(async () => ({
      submissions: [submission(9)],
      nextCursor: null,
    }))
    renderDashboard()
    await mountShell(
      dashboardApi('member', {
        getUninvoicedReport,
        listInvoices,
        listPendingTimesheetSubmissions,
      }),
    )

    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-profile]')?.textContent).toBe('member'),
    )
    // A filtered set, not an empty screen: your own week is still yours.
    await vi.waitFor(() => expect(cardKeys()).toEqual(['week']))
    expect(figure('week')).toBe('3 h')

    expect(getUninvoicedReport).not.toHaveBeenCalled()
    expect(listInvoices).not.toHaveBeenCalled()
    expect(listPendingTimesheetSubmissions).not.toHaveBeenCalled()
    // And the gate the cards read is the nav item itself, still shut.
    expect(
      document.querySelector<HTMLElement>('.primary-nav [data-money-nav]')?.hidden,
    ).toBe(true)
    expect(
      document.querySelector<HTMLElement>('.primary-nav a[href="/approvals"]')?.hidden,
    ).toBe(true)
  })

  it('[browser] gives an administrator the four figures, including the cards whose gates open late', async () => {
    const getUninvoicedReport = vi.fn(async () => uninvoicedReport(true))
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport,
        listInvoices: vi.fn(async () => ({
          data: [
            invoice({ id: 1, due_amount_cents: 90_000, due_date: '2020-02-01' }),
            invoice({ id: 2, due_amount_cents: 30_000, due_date: '2999-01-01' }),
            invoice({ id: 3, state: 'paid', due_amount_cents: 400_000 }),
          ],
          page: { next_cursor: null },
        })),
        listPendingTimesheetSubmissions: vi.fn(async () => ({
          submissions: [submission(9), submission(10)],
          nextCursor: null,
        })),
        getTeamStatus: vi.fn(async () => ({ enabled: true })),
        getTeamPerson: vi.fn(async () => person(126_000)),
      }),
    )

    // Approvals and Team answer their module probes after this screen has
    // already painted once. The cards follow the nav rather than racing it.
    await vi.waitFor(() =>
      expect(cardKeys()).toEqual(['week', 'approvals', 'uninvoiced', 'owed']),
    )

    expect(figure('week')).toBe('3 h')
    await vi.waitFor(() => expect(detail('week')).toContain('against 35 h of capacity'))
    expect(note('week')).toBe('This week is not submitted.')

    expect(figure('approvals')).toBe('2')
    expect(note('approvals')).toBe('Someone is waiting on this.')

    expect(figure('uninvoiced')).toBe('$1,250.00')
    const range = uninvoicedWindow(localDate())
    expect(
      document
        .querySelector<HTMLAnchorElement>('[data-dashboard-card="uninvoiced"] [data-dashboard-link]')
        ?.getAttribute('href'),
    ).toBe(`/reports?report=uninvoiced&from=${range.from}&to=${range.to}`)
    expect(getUninvoicedReport).toHaveBeenCalledWith(range, expect.anything())

    // Only the two open invoices, and only the one past its due date is called
    // out. The paid one carries a due amount and must not be in either.
    expect(figure('owed')).toBe('$1,200.00')
    expect(detail('owed')).toBe('Unpaid on 2 open invoices.')
    expect(note('owed')).toBe('1 invoice past due.')
  })

  it('[browser #521] marks the two figures that are money and leaves the hours and the count alone', async () => {
    // The distinction the $ toggle turns on, on the one screen that draws all
    // three kinds of number at once. A week of hours and a queue depth are not
    // amounts and stay on screen when the amounts go -- masking a timesheet
    // would be a different feature and a worse one.
    //
    // Discretion, not permission: the payload is unchanged, `canViewMoneyField`
    // is not consulted, and the card still holds the figure it declines to draw.
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport: vi.fn(async () => uninvoicedReport(true)),
        listInvoices: vi.fn(async () => ({
          data: [invoice({ id: 1, due_amount_cents: 90_000 })],
          page: { next_cursor: null },
        })),
        listPendingTimesheetSubmissions: vi.fn(async () => ({
          submissions: [submission(9)],
          nextCursor: null,
        })),
      }),
    )
    await vi.waitFor(() => expect(cardKeys()).toEqual(['week', 'approvals', 'uninvoiced', 'owed']))
    await vi.waitFor(() => expect(figure('owed')).toBe('$900.00'))

    // Counted before the split, so a run that found no figures at all cannot
    // pass the comparison below by matching two empty sets.
    const figures = [...document.querySelectorAll('[data-dashboard-figure]')]
    expect(figures).toHaveLength(4)
    const marked = figures
      .filter((element) => element.classList.contains('money'))
      .map((element) =>
        element.closest('[data-dashboard-card]')!.getAttribute('data-dashboard-card'),
      )
    expect(marked).toEqual(['uninvoiced', 'owed'])
    expect(figure('week')).toBe('3 h')
    expect(figure('approvals')).toBe('1')

    const control = document.querySelector<HTMLButtonElement>('[data-money-toggle]')!
    control.click()
    expect(document.documentElement.getAttribute('data-money')).toBe('hidden')
    // The figures are still there to be totalled and linked from; the stylesheet
    // is what declines to draw the two that said they are amounts.
    expect(figure('uninvoiced')).toBe('$1,250.00')
    expect(figure('week')).toBe('3 h')
  })

  it('[browser #521] takes the marker off a card that has no amount to show', async () => {
    // "None" is a statement about the book, not a figure, and dots drawn over it
    // would claim there is a number behind them.
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport: vi.fn(async () => uninvoicedReport(true)),
        listInvoices: vi.fn(async () => ({ data: [], page: { next_cursor: null } })),
      }),
    )
    await vi.waitFor(() => expect(figure('owed')).toBe('None'))
    expect(
      document
        .querySelector('[data-dashboard-card="owed"] [data-dashboard-figure]')!
        .classList.contains('money'),
    ).toBe(false)
    // And the card beside it, which does have one, still carries it.
    await vi.waitFor(() => expect(figure('uninvoiced')).toBe('$1,250.00'))
    expect(
      document
        .querySelector('[data-dashboard-card="uninvoiced"] [data-dashboard-figure]')!
        .classList.contains('money'),
    ).toBe(true)
  })

  it("[security #491] keeps the firm's directories out of a member's nav and leaves a manager's whole", async () => {
    // Projects, Tasks and Clients browse the firm rather than the reader. A
    // member's nav is the four sections that are their own work, and the
    // palette follows without a rule of its own because ⌘K reads these nav
    // items. What the member loses is the firm-wide list, not the app: the API
    // still answers them with the work they are assigned to.
    const directories = (): Record<string, boolean | undefined> =>
      Object.fromEntries(
        ['/projects', '/tasks', '/clients'].map((href) => [
          href,
          document.querySelector<HTMLElement>(`.primary-nav a[href="${href}"]`)?.hidden,
        ]),
      )

    renderDashboard()
    await mountShell(dashboardApi('member'))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-profile]')?.textContent).toBe('member'),
    )
    expect(directories()).toEqual({ '/projects': true, '/tasks': true, '/clients': true })
    // Their own four are untouched: this withholds the directories, not the app.
    for (const href of ['/dashboard', '/', '/expenses', '/reports']) {
      expect(
        document.querySelector<HTMLElement>(`.primary-nav a[href="${href}"]`)?.hidden,
        href,
      ).toBe(false)
    }

    renderDashboard()
    await mountShell(dashboardApi('project_manager'))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-profile]')?.textContent).toBe(
        'project manager',
      ),
    )
    expect(directories()).toEqual({ '/projects': false, '/tasks': false, '/clients': false })
  })

  it('[security] withdraws the card when the server withholds the money the gate admitted', async () => {
    // The nav gate is a presentation rule; the serializer is the authority. If
    // they ever disagree the card leaves rather than standing there with a dash
    // where an amount belongs.
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport: vi.fn(async () => uninvoicedReport(false)),
        listInvoices: vi.fn(async () => ({ data: [], page: { next_cursor: null } })),
      }),
    )

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('.primary-nav [data-money-nav]')?.hidden,
      ).toBe(false),
    )
    await vi.waitFor(() => expect(cardKeys()).toContain('owed'))
    expect(cardKeys()).not.toContain('uninvoiced')
    expect(figure('owed')).toBe('None')
    expect(detail('owed')).toBe('No open invoice is unpaid.')
  })
})

describe('what the owed card is allowed to claim', () => {
  it('[browser] never presents the start of the book as what is owed now', async () => {
    // /api/v1/invoices pages ascending by id, so a walk that stops short has
    // read the OLDEST invoices. On a book longer than the walk those are the
    // settled ones, and the open, overdue invoice at the far end is unread.
    // The card must not answer with that slice under any present-tense label.
    const pages: Invoice[][] = Array.from({ length: 10 }, (_unused, index) => [
      invoice({ id: index + 1, state: 'paid', due_amount_cents: 0 }),
    ])
    pages.push([
      invoice({
        id: 999,
        state: 'open',
        due_amount_cents: 750_000,
        due_date: '2020-01-05',
      }),
    ])
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport: vi.fn(async () => uninvoicedReport(true)),
        listInvoices: pagedInvoices(pages),
      }),
    )

    await vi.waitFor(() => expect(cardKeys()).toContain('owed'))
    await vi.waitFor(() => expect(detail('owed')).not.toBe(''))
    expect(detail('owed')).not.toContain('most recent')
    expect(figure('owed')).not.toBe('None')
    expect(figure('owed')).toBe('—')
    expect(detail('owed')).toBe(
      'More invoices than this screen can total. Open invoices to see what is owed.',
    )
    expect(note('owed')).toBe('')
  })

  it('[browser] totals the whole book when the walk reaches the end of it', async () => {
    const listInvoices = pagedInvoices([
      [invoice({ id: 1, state: 'paid', due_amount_cents: 0 })],
      [invoice({ id: 2, due_amount_cents: 90_000, due_date: '2020-02-01' })],
    ])
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport: vi.fn(async () => uninvoicedReport(true)),
        listInvoices,
      }),
    )

    await vi.waitFor(() => expect(detail('owed')).toBe('Unpaid on 1 open invoice.'))
    expect(figure('owed')).toBe('$900.00')
    expect(note('owed')).toBe('1 invoice past due.')
    // The walk asks for the largest page the API will serve, so the ceiling
    // buys coverage of a real book rather than of its first few hundred rows.
    expect(listInvoices).toHaveBeenCalledWith(undefined, expect.anything(), 200)
  })

  it('[browser] admits one late gate without re-running the cards already read', async () => {
    const listInvoices = pagedInvoices([
      [invoice({ id: 1, due_amount_cents: 90_000, due_date: '2020-02-01' })],
      [invoice({ id: 2, state: 'paid', due_amount_cents: 0 })],
    ])
    const getUninvoicedReport = vi.fn(async () => uninvoicedReport(true))
    const listPendingTimesheetSubmissions = vi.fn(async () => ({
      submissions: [submission(9)],
      nextCursor: null,
    }))
    const getTimeEntrySettings = vi.fn(async () => ({
      time_entry_mode: 'duration' as const,
      time_format: 'decimal' as const,
      clock: '12h' as const,
      week_start_day: 'monday' as const,
    }))
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport,
        listInvoices,
        listPendingTimesheetSubmissions,
        getTimeEntrySettings,
        getTeamStatus: vi.fn(async () => ({ enabled: true })),
        getTeamPerson: vi.fn(async () => person(126_000)),
      }),
    )

    await vi.waitFor(() =>
      expect(cardKeys()).toEqual(['week', 'approvals', 'uninvoiced', 'owed']),
    )
    await vi.waitFor(() => expect(detail('week')).toContain('against 35 h of capacity'))
    await vi.waitFor(() => expect(detail('owed')).toBe('Unpaid on 1 open invoice.'))

    // Two nav gates open after this screen starts: Approvals, then Team. Only
    // what each admits is read again -- the invoice walk is one walk.
    expect(listInvoices).toHaveBeenCalledTimes(2)
    expect(getUninvoicedReport).toHaveBeenCalledTimes(1)
    expect(listPendingTimesheetSubmissions).toHaveBeenCalledTimes(1)
    // Team answered before the week card asked for capacity, so the week card
    // read once and got the number on that read. The second call to this
    // endpoint is the shell's own, for the week it starts the timesheet on --
    // it is not a second pass over the card.
    expect(getTimeEntrySettings).toHaveBeenCalledTimes(2)
  })

  it('[browser] reads the week card again when Team answers after it', async () => {
    // The gate this clause exists for is the one that opens *after* the week
    // card has already asked for capacity and been told there is none on
    // offer. Nothing about the card set changes when Team appears -- the week
    // card is ungated and was on the page from the first pass -- so a re-read
    // keyed on the card set alone leaves the capacity clause permanently
    // missing. Here getTeamStatus is held until the card has settled without
    // it, which is the ordering the happy path never produces on its own.
    let admitTeam = (): void => {}
    const teamAnswered = new Promise<void>((resolve) => {
      admitTeam = resolve
    })
    const getTeamPerson = vi.fn(async () => person(126_000))
    renderDashboard()
    await mountShell(
      dashboardApi('administrator', {
        getUninvoicedReport: vi.fn(async () => uninvoicedReport(true)),
        listInvoices: pagedInvoices([[invoice({ id: 1, state: 'paid', due_amount_cents: 0 })]]),
        getTeamStatus: vi.fn(async () => {
          await teamAnswered
          return { enabled: true }
        }),
        getTeamPerson,
      }),
    )

    // The card is complete and correct without capacity: one clause fewer, not
    // a blank where a number should be.
    await vi.waitFor(() =>
      expect(detail('week')).toBe(`Tracked ${week.from} to ${week.to}.`),
    )
    expect(getTeamPerson).not.toHaveBeenCalled()

    admitTeam()

    await vi.waitFor(() =>
      expect(detail('week')).toBe(
        `Tracked ${week.from} to ${week.to}, against 35 h of capacity.`,
      ),
    )
    expect(getTeamPerson).toHaveBeenCalledTimes(1)
  })

  it('[browser] clears a failure when its card leaves the gated set', async () => {
    // The status counted a card the page no longer shows, and Retry could not
    // clear it: layOutCards will not return an ungated card, so nothing re-ran
    // and nothing removed the key. The page was stranded on "1 card could not
    // be loaded." with a button that did nothing.
    const getUninvoicedReport = vi.fn(async () => {
      throw new Error('The report could not be loaded.')
    })
    renderDashboard()
    await mountShell(dashboardApi('administrator', { getUninvoicedReport }))

    const status = document.querySelector<HTMLElement>('[data-dashboard-status]')!
    await vi.waitFor(() => expect(status.textContent).toBe('1 card could not be loaded.'))

    // The money gate closes — the same nav mutation this controller watches.
    const moneyNav = document.querySelector<HTMLElement>('.primary-nav [data-money-nav]')!
    moneyNav.hidden = true

    await vi.waitFor(() => expect(status.textContent).toBe(''))
    expect(document.querySelector<HTMLButtonElement>('[data-dashboard-retry]')!.hidden).toBe(
      true,
    )
    // The card really is gone, rather than merely uncounted: layOutCards
    // replaces the container's children with the gated set, so an ungated card
    // leaves the document rather than staying hidden in it.
    expect(document.querySelector('[data-dashboard-card="uninvoiced"]')).toBeNull()
  })

  it('[browser] retries the card that failed, and only that card', async () => {
    let attempts = 0
    const getUninvoicedReport = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('The report could not be loaded.')
      return uninvoicedReport(true)
    })
    const listInvoices = pagedInvoices([
      [invoice({ id: 1, due_amount_cents: 90_000, due_date: '2020-02-01' })],
    ])
    renderDashboard()
    await mountShell(dashboardApi('administrator', { getUninvoicedReport, listInvoices }))

    await vi.waitFor(() =>
      expect(document.querySelector('[data-dashboard-status]')?.textContent).toBe(
        '1 card could not be loaded.',
      ),
    )
    expect(detail('uninvoiced')).toBe('This could not be loaded.')
    const retry = document.querySelector<HTMLButtonElement>('[data-dashboard-retry]')!
    expect(retry.hidden).toBe(false)

    retry.click()
    await vi.waitFor(() => expect(figure('uninvoiced')).toBe('$1,250.00'))
    expect(retry.hidden).toBe(true)
    expect(document.querySelector('[data-dashboard-status]')?.textContent).toBe('')
    // The invoice walk answered the first time. Retry is not a page reload.
    expect(listInvoices).toHaveBeenCalledTimes(1)
  })
})
