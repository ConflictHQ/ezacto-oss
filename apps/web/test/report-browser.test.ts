/** @vitest-environment happy-dom */

import type {
  DetailedTimeReport,
  DetailedTimeRow,
  GeneralResource,
  TimeReport,
  Whoami,
} from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createReportsController } from '../src/reports/browser.js'
import type { ReportWorkspaceApi } from '../src/reports/model.js'
import { renderAppShell, reportKindTabs } from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const client = (id: number, name: string, fields: Record<string, unknown> = {}): GeneralResource => ({
  id,
  name,
  currency: 'USD',
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})
const project = (id: number, name: string, fields: Record<string, unknown> = {}): GeneralResource => ({
  id,
  name,
  client_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})
const page = (data: readonly GeneralResource[], next_cursor: string | null = null) => ({
  data,
  page: { next_cursor },
})
const identity = (profile: Whoami['profile']): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

const writeDocument = (path: string): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'report-browser-test',
      activeSection: 'Reports',
      view: 'reports',
      // The strip the /reports route hands the shell: the controller reads the
      // kinds off it, so a document without it is not the page under test.
      tabs: reportKindTabs(new URL(path, 'https://example.test').searchParams.get('report')),
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

/** The shape with nothing in it; the tests that measure rows build their own. */
const emptyTimeReport: TimeReport = {
  from: '2026-08-01',
  to: '2026-08-31',
  totals: {
    seconds: 0,
    rounded_seconds: 0,
    billable_seconds: 0,
    time_entry_count: 0,
    unpriced_billable_entry_count: 0,
    amounts: [],
  },
  clients: [],
  projects: [],
  tasks: [],
  teammates: [],
}

const emptyProfitTotals = {
  rounded_seconds: 0,
  revenue_cents: 0,
  cost_cents: 0,
  profit_cents: 0,
  entries_without_billable_rate: 0,
  entries_without_cost_rate: 0,
  projects_not_converted: 0,
}

const baseApi = (overrides: Partial<ReportWorkspaceApi> = {}): Partial<ReportWorkspaceApi> => ({
  listReportClients: vi.fn(async () => page([client(1, 'Parent'), client(2, 'Studio', { parent_client_id: 1, currency: 'EUR' })])),
  listReportProjects: vi.fn(async () => page([project(7, 'Launch', { code: 'WEB', client_id: 2 })])),
  getUninvoicedReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    client_id: null,
    project_id: null,
    totals: [],
  })),
  getClientRollupReport: vi.fn(async () => ({
    root_client_id: 1,
    from: '2026-08-01',
    to: '2026-08-31',
    nodes: [],
  })),
  getProjectBudgetReport: vi.fn(async () => ({
    project_id: 7,
    budget_by: 'project' as const,
    expenses_included: false,
    from: '2026-08-01',
    to: '2026-08-31',
    grains: [],
  })),
  getMyHoursReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    user_id: 1,
    project_id: null,
    seconds: 0,
    rounded_seconds: 0,
    billable_seconds: 0,
    time_entry_count: 0,
    projects: [],
  })),
  getContractorCostReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    rows: [],
  })),
  getDetailedTimeReport: vi.fn(async () => detailedTimeReport()),
  getTimeReport: vi.fn(async () => emptyTimeReport),
  getActivityLog: vi.fn(async () => []),
  getDetailedExpenseReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    client_id: null,
    project_id: null,
    billable_only: false,
    totals: [],
    rows: [],
  })),
  getProfitabilityReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    organization_currency: 'USD',
    rows: [],
    totals: emptyProfitTotals,
    previous_from: '2026-07-01',
    previous_to: '2026-07-31',
    previous_totals: emptyProfitTotals,
  })),
  ...overrides,
})

const detailedTimeRow = (fields: Partial<DetailedTimeRow> = {}): DetailedTimeRow => ({
  spent_date: '2026-08-10',
  client_id: 1,
  client_name: 'Parent',
  project_id: 7,
  project_name: 'Launch',
  project_code: 'WEB',
  task_id: 3,
  task_name: 'Delivery',
  user_id: 1,
  user_name: 'Ada Lovelace',
  roles: ['Engineering'],
  currency: 'USD',
  seconds: 3_600,
  rounded_seconds: 3_600,
  billable_seconds: 3_600,
  uninvoiced_billable_seconds: 3_600,
  time_entry_count: 1,
  billable_amount_cents: 10_000,
  entries_without_billable_rate: 0,
  ...fields,
})

const detailedTimeReport = (
  fields: Partial<DetailedTimeReport> = {},
): DetailedTimeReport => ({
  from: '2026-08-01',
  to: '2026-08-31',
  client_id: null,
  project_id: null,
  hours: 'all',
  active_projects_only: false,
  seconds: 0,
  rounded_seconds: 0,
  billable_seconds: 0,
  uninvoiced_billable_seconds: 0,
  time_entry_count: 0,
  currencies: [],
  rows: [],
  ...fields,
})

describe('Reports Stage 1 browser controller', () => {
  it('[browser] follows the newest popstate filters when a report request is in flight', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    let resolveUninvoiced!: (value: {
      from: string
      to: string
      client_id: null
      project_id: null
      totals: []
    }) => void
    const pendingUninvoiced = new Promise<{
      from: string
      to: string
      client_id: null
      project_id: null
      totals: []
    }>((resolve) => {
      resolveUninvoiced = resolve
    })
    const getUninvoicedReport = vi.fn(async () => pendingUninvoiced)
    const getProjectBudgetReport = vi.fn(async () => ({
      project_id: 7,
      budget_by: 'project' as const,
      expenses_included: false,
      from: '2026-08-01',
      to: '2026-08-31',
      grains: [
        {
          source: 'project' as const,
          source_id: 7,
          unit: 'seconds' as const,
          calculation: 'time' as const,
          unpriced_entry_count: 0,
          budget_seconds: 7_200,
          spent_seconds: 1_800,
          remaining_seconds: 5_400,
        },
      ],
    }))
    const controller = createReportsController(
      baseApi({ getUninvoicedReport, getProjectBudgetReport }),
    )
    const session = new AbortController()
    const activation = controller.activate(identity('administrator'), session.signal, () => false)
    await vi.waitFor(() => expect(getUninvoicedReport).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-report-results]')?.getAttribute('aria-busy')).toBe(
      'true',
    )

    window.history.pushState(
      null,
      '',
      '/reports?report=project-budget&from=2026-08-01&to=2026-08-31&project_id=7',
    )
    window.dispatchEvent(new PopStateEvent('popstate'))
    resolveUninvoiced({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [],
    })
    await activation
    await vi.waitFor(() => expect(getProjectBudgetReport).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-report-results]')?.textContent).toContain(
        'Project budget',
      ),
    )
    expect(document.querySelector('[data-report-results]')?.textContent).not.toContain(
      'Uninvoiced work',
    )
    session.abort()
  })

  it('[security] clears stale private results across logout and relogin while loading', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    let resolveOld!: (value: {
      from: string
      to: string
      client_id: null
      project_id: null
      totals: Array<{
        currency: string
        rounded_seconds: number
        time_entry_count: number
        unpriced_time_entry_count: number
        expense_count: number
        total_cents: number
      }>
    }) => void
    const oldReport = new Promise<Parameters<typeof resolveOld>[0]>((resolve) => {
      resolveOld = resolve
    })
    const report = (total_cents: number) => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [
        {
          currency: 'USD',
          rounded_seconds: 0,
          time_entry_count: 0,
          unpriced_time_entry_count: 0,
          expense_count: 0,
          total_cents,
        },
      ],
    })
    const getUninvoicedReport = vi
      .fn()
      .mockImplementationOnce(async () => oldReport)
      .mockResolvedValueOnce(report(20_000))
    const controller = createReportsController(baseApi({ getUninvoicedReport }))
    const oldSession = new AbortController()
    const oldActivation = controller.activate(
      identity('administrator'),
      oldSession.signal,
      () => false,
    )
    await vi.waitFor(() => expect(getUninvoicedReport).toHaveBeenCalledTimes(1))

    oldSession.abort()
    expect(document.querySelector('[data-report-client]')?.textContent).toBe('')
    expect(document.querySelector('[data-report-results]')?.textContent).toBe('')
    const newSession = new AbortController()
    const newActivation = controller.activate(
      identity('administrator'),
      newSession.signal,
      () => false,
    )
    expect(document.querySelector('[data-report-results]')?.textContent).toBe('')
    await newActivation
    expect(document.querySelector('[data-report-results]')?.textContent).toContain('$200.00')

    resolveOld(report(10_000))
    await oldActivation
    expect(document.querySelector('[data-report-results]')?.textContent).toContain('$200.00')
    expect(document.querySelector('[data-report-results]')?.textContent).not.toContain('$100.00')
    newSession.abort()
  })

  it('[security] ignores an old report failure after the next session is active', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    let rejectOldReport!: (reason: unknown) => void
    const oldReport = new Promise<never>((_, reject) => {
      rejectOldReport = reject
    })
    const getUninvoicedReport = vi
      .fn()
      .mockImplementationOnce(async () => oldReport)
      .mockResolvedValueOnce({
        from: '2026-08-01',
        to: '2026-08-31',
        client_id: null,
        project_id: null,
        totals: [
          {
            currency: 'USD',
            rounded_seconds: 0,
            time_entry_count: 0,
            unpriced_time_entry_count: 0,
            expense_count: 0,
            total_cents: 20_000,
          },
        ],
      })
    const controller = createReportsController(baseApi({ getUninvoicedReport }))
    const oldSessionFailure = vi.fn(() => false)
    const oldSession = new AbortController()
    const oldActivation = controller.activate(
      identity('administrator'),
      oldSession.signal,
      oldSessionFailure,
    )
    await vi.waitFor(() => expect(getUninvoicedReport).toHaveBeenCalledTimes(1))

    oldSession.abort()
    const newSession = new AbortController()
    await controller.activate(identity('administrator'), newSession.signal, () => false)
    expect(document.querySelector('[data-report-results]')?.textContent).toContain('$200.00')
    rejectOldReport(new Error('Old report failed.'))
    await oldActivation

    expect(oldSessionFailure).not.toHaveBeenCalled()
    expect(document.querySelector('[data-report-results]')?.textContent).toContain('$200.00')
    expect(document.querySelector('[data-report-status]')?.textContent).not.toContain(
      'Old report failed.',
    )
    newSession.abort()
  })

  it('[security] discards an old paginated catalog after logout and relogin', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    let resolveOldClients!: (value: ReturnType<typeof page>) => void
    const oldClients = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveOldClients = resolve
    })
    const listReportClients = vi
      .fn()
      .mockImplementationOnce(async () => oldClients)
      .mockResolvedValueOnce(page([client(9, 'New session client')]))
    const listReportProjects = vi
      .fn()
      .mockResolvedValueOnce(page([project(8, 'Old project')]))
      .mockResolvedValueOnce(page([project(10, 'New session project')]))
    const api = baseApi({ listReportClients, listReportProjects })
    const controller = createReportsController(api)
    const oldSession = new AbortController()
    const oldActivation = controller.activate(
      identity('administrator'),
      oldSession.signal,
      () => false,
    )
    await vi.waitFor(() => expect(listReportClients).toHaveBeenCalledTimes(1))

    oldSession.abort()
    const newSession = new AbortController()
    await controller.activate(identity('administrator'), newSession.signal, () => false)
    expect(document.querySelector('[data-report-client]')?.textContent).toContain(
      'New session client',
    )
    expect(document.querySelector('[data-report-project]')?.textContent).toContain(
      'New session project',
    )

    resolveOldClients(page([client(8, 'Old session client')]))
    await oldActivation
    window.history.pushState(
      null,
      '',
      '/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31&client_id=9&project_id=10',
    )
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(document.querySelector('[data-report-client]')?.textContent).toContain(
      'New session client',
    )
    expect(document.querySelector('[data-report-project]')?.textContent).toContain(
      'New session project',
    )
    expect(document.querySelector('[data-report-client]')?.textContent).not.toContain(
      'Old session client',
    )
    expect(document.querySelector('[data-report-project]')?.textContent).not.toContain(
      'Old project',
    )
    newSession.abort()
  })

  it('[security] ignores an old catalog failure after the next session is active', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    let rejectOldClients!: (reason: unknown) => void
    const oldClients = new Promise<ReturnType<typeof page>>((_, reject) => {
      rejectOldClients = reject
    })
    const listReportClients = vi
      .fn()
      .mockImplementationOnce(async () => oldClients)
      .mockResolvedValueOnce(page([client(9, 'Current client')]))
    const listReportProjects = vi
      .fn()
      .mockResolvedValueOnce(page([project(8, 'Old project')]))
      .mockResolvedValueOnce(page([project(10, 'Current project')]))
    const controller = createReportsController(
      baseApi({ listReportClients, listReportProjects }),
    )
    const oldSessionFailure = vi.fn(() => false)
    const oldSession = new AbortController()
    const oldActivation = controller.activate(
      identity('administrator'),
      oldSession.signal,
      oldSessionFailure,
    )
    await vi.waitFor(() => expect(listReportClients).toHaveBeenCalledTimes(1))

    oldSession.abort()
    const newSession = new AbortController()
    await controller.activate(identity('administrator'), newSession.signal, () => false)
    rejectOldClients(new Error('Old session catalog failed.'))
    await oldActivation

    expect(oldSessionFailure).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(document.querySelector('[data-report-client]')?.textContent).toContain(
      'Current client',
    )
    expect(document.querySelector('[data-report-project]')?.textContent).toContain(
      'Current project',
    )
    expect(document.querySelector('[data-report-status]')?.textContent).not.toContain(
      'Old session catalog failed.',
    )
    newSession.abort()
  })

  it('[browser] clears old results and retry state when new filters are invalid', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [
        {
          currency: 'USD',
          rounded_seconds: 3_600,
          time_entry_count: 1,
          unpriced_time_entry_count: 0,
          expense_count: 0,
          total_cents: 12_345,
        },
      ],
    }))
    const controller = createReportsController(baseApi({ getUninvoicedReport }))
    const session = new AbortController()
    await controller.activate(identity('administrator'), session.signal, () => false)

    const form = document.querySelector<HTMLFormElement>('[data-report-form]')!
    const from = document.querySelector<HTMLInputElement>('[data-period-from]')!
    const to = document.querySelector<HTMLInputElement>('[data-period-to]')!
    const results = document.querySelector<HTMLElement>('[data-report-results]')!
    const retry = document.querySelector<HTMLButtonElement>('[data-report-retry]')!
    const run = document.querySelector<HTMLButtonElement>('[data-report-run]')!
    expect(results.textContent).toContain('$123.45')

    from.value = '2026-09-02'
    to.value = '2026-09-01'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(results.textContent).toBe('')
    expect(results.hasAttribute('aria-busy')).toBe(false)
    expect(retry.hidden).toBe(true)
    expect(run.disabled).toBe(false)
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'To must be on or after From.',
    )

    from.value = '2026-08-01'
    to.value = '2026-08-31'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(getUninvoicedReport).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(results.textContent).toContain('$123.45'))

    window.history.pushState(
      null,
      '',
      '/reports?report=uninvoiced&from=2026-09-02&to=2026-09-01',
    )
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(results.textContent).toBe('')
    expect(results.hasAttribute('aria-busy')).toBe(false)
    expect(retry.hidden).toBe(true)
    expect(run.disabled).toBe(false)
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'To must be on or after From.',
    )
    session.abort()
  })

  it('[browser] clears a stale retry action before showing validation feedback', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn().mockRejectedValue(new Error('Temporary failure.'))
    const session = new AbortController()
    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )
    const retry = document.querySelector<HTMLButtonElement>('[data-report-retry]')!
    expect(retry.hidden).toBe(false)

    document.querySelector<HTMLInputElement>('[data-period-from]')!.value = '2026-09-02'
    document.querySelector<HTMLInputElement>('[data-period-to]')!.value = '2026-09-01'
    document
      .querySelector<HTMLFormElement>('[data-report-form]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(retry.hidden).toBe(true)
    retry.click()
    expect(getUninvoicedReport).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-report-results]')?.textContent).toBe('')
    session.abort()
  })

  it('[browser] clears old results when report APIs become unavailable', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const api = baseApi({
      getUninvoicedReport: vi.fn(async () => ({
        from: '2026-08-01',
        to: '2026-08-31',
        client_id: null,
        project_id: null,
        totals: [
          {
            currency: 'USD',
            rounded_seconds: 0,
            time_entry_count: 0,
            unpriced_time_entry_count: 0,
            expense_count: 0,
            total_cents: 10_000,
          },
        ],
      })),
    })
    const session = new AbortController()
    await createReportsController(api).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )
    expect(document.querySelector('[data-report-results]')?.textContent).toContain('$100.00')

    delete api.getClientRollupReport
    document
      .querySelector<HTMLFormElement>('[data-report-form]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(document.querySelector('[data-report-results]')?.textContent).toBe('')
    expect(document.querySelector('[data-report-results]')?.hasAttribute('aria-busy')).toBe(
      false,
    )
    expect(document.querySelector('[data-report-retry]')?.hasAttribute('hidden')).toBe(
      true,
    )
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'Reports are unavailable in this build.',
    )
    session.abort()
  })

  it('[browser] pages catalogs and renders every uninvoiced currency without inventing redacted money', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const listReportClients = vi
      .fn()
      .mockResolvedValueOnce(page([client(1, 'Parent')], 'next'))
      .mockResolvedValueOnce(page([client(2, 'Studio', { currency: 'EUR' })]))
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [
        {
          currency: 'USD',
          rounded_seconds: 3_600,
          time_entry_count: 2,
          unpriced_time_entry_count: 1,
          expense_count: 1,
          time_cents: 10_000,
          expense_cents: 500,
          total_cents: 10_500,
        },
        {
          currency: 'EUR',
          rounded_seconds: 1_800,
          time_entry_count: 1,
          unpriced_time_entry_count: 0,
          expense_count: 0,
        },
      ],
    }))
    const api = baseApi({ listReportClients, getUninvoicedReport })

    await createReportsController(api).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    expect(listReportClients).toHaveBeenCalledTimes(2)
    expect(getUninvoicedReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.any(AbortSignal),
    )
    const results = document.querySelector('[data-report-results]')!
    expect(results.querySelectorAll('.report-currency-card')).toHaveLength(2)
    expect(results.textContent).toContain('$105.00')
    expect(results.textContent).toContain('EUR')
    expect(results.textContent).toContain('—')
    expect(results.textContent).toContain('without a resolved rate')
  })

  it('[browser] makes client hierarchy and direct-versus-descendant rollups explicit', async () => {
    writeDocument('/reports?report=client-rollup&from=2026-08-01&to=2026-08-31&client_id=1')
    const metrics = (seconds: number) => ({
      time_entry_count: 1,
      expense_count: 0,
      rounded_seconds: seconds,
      billable_seconds: seconds,
      budgeted_seconds: 0,
      time_budget_seconds: 0,
      unpriced_billable_entry_count: 0,
      unpriced_cost_entry_count: 0,
      currencies: [{ currency: 'USD', expense_cents: 0, uninvoiced_total_cents: seconds }],
    })
    const api = baseApi({
      getClientRollupReport: vi.fn(async () => ({
        root_client_id: 1,
        from: '2026-08-01',
        to: '2026-08-31',
        nodes: [
          { client_id: 1, name: 'Parent', parent_client_id: null, depth: 0, direct: metrics(1_800), rollup: metrics(5_400) },
          { client_id: 2, name: 'Studio', parent_client_id: 1, depth: 1, direct: metrics(3_600), rollup: metrics(3_600) },
        ],
      })),
    })

    await createReportsController(api).activate(
      identity('accounting'),
      new AbortController().signal,
      () => false,
    )

    const results = document.querySelector('[data-report-results]')!
    expect(results.textContent).toContain('Root client')
    expect(results.textContent).toContain('Child of Parent')
    // Every client the rollup names is the name, and a way into that client.
    expect(
      [...results.querySelectorAll('a')].map((link) => [
        link.getAttribute('href'),
        link.textContent,
      ]),
    ).toEqual([
      ['/clients/1', 'Parent'],
      ['/clients/1', 'Parent'],
      ['/clients/2', 'Studio'],
      ['/clients/1', 'Parent'],
    ])
    expect(results.textContent).not.toContain('#1')
    expect(results.textContent).not.toContain('#2')
    expect(results.querySelectorAll('h4')[0]?.textContent).toBe('Direct activity')
    expect(results.querySelectorAll('h4')[1]?.textContent).toBe('Including descendants')
  })

  it('[browser] switches kind from the tab strip and keeps the range on screen', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getClientRollupReport = vi.fn(async () => ({
      root_client_id: 1,
      from: '2026-08-01',
      to: '2026-08-31',
      nodes: [],
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getClientRollupReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    const tabs = [...document.querySelectorAll<HTMLAnchorElement>('.tabstrip a[href^="/reports"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'My hours',
      'Time',
      'Uninvoiced work',
      'Detailed time',
      'Detailed expense',
      'Client rollup',
      'Activity log',
      'Project budget',
      'Profitability',
      'Contractor cost',
    ])
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    // Every tab is a real address, and it carries the range being looked at.
    const rollupTab = tabs.find((tab) => tab.textContent === 'Client rollup')!
    expect(rollupTab.getAttribute('href')).toBe(
      '/reports?report=client-rollup&from=2026-08-01&to=2026-08-31',
    )

    document.querySelector<HTMLSelectElement>('[data-report-client]')!.value = '1'
    rollupTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(getClientRollupReport).toHaveBeenCalledTimes(1))
    expect(getClientRollupReport).toHaveBeenCalledWith(
      1,
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/reports?report=client-rollup&from=2026-08-01&to=2026-08-31&client_id=1',
    )
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([
      null,
      null,
      null,
      null,
      null,
      'page',
      null,
      null,
      null,
      null,
    ])
    expect(document.querySelector<HTMLElement>('[data-report-project-field]')?.hidden).toBe(true)
    session.abort()
  })

  it('[security] lets an assigned member request project budget while financial kinds leave the strip', async () => {
    writeDocument('/reports?report=project-budget&from=2026-08-01&to=2026-08-31&project_id=7')
    const getProjectBudgetReport = vi.fn(async () => ({
      project_id: 7,
      budget_by: 'task_fees' as const,
      expenses_included: true,
      from: '2026-08-01',
      to: '2026-08-31',
      grains: [
        {
          source: 'task_assignment' as const,
          source_id: 22,
          unit: 'cents' as const,
          calculation: 'billable' as const,
          unpriced_entry_count: 2,
        },
        {
          source: 'project' as const,
          source_id: 7,
          unit: 'seconds' as const,
          calculation: 'time' as const,
          unpriced_entry_count: 0,
          budget_seconds: 7_200,
          spent_seconds: 3_600,
          remaining_seconds: 3_600,
        },
      ],
    }))
    const getUninvoicedReport = vi.fn()
    const api = baseApi({ getProjectBudgetReport, getUninvoicedReport })

    await createReportsController(api).activate(
      identity('member'),
      new AbortController().signal,
      () => false,
    )

    expect(getProjectBudgetReport).toHaveBeenCalledTimes(1)
    expect(getUninvoicedReport).not.toHaveBeenCalled()
    // Hidden, not disabled: a member is told nothing by a control that refuses
    // to work, so the two financial kinds are simply not in the strip.
    expect(
      [...document.querySelectorAll('.tabstrip a[href^="/reports"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(['My hours', 'Project budget'])
    const results = document.querySelector('[data-report-results]')!
    // No catalog resolves an assignment, so its id stays; the project has one.
    expect(results.textContent).toContain('Task assignment #22')
    expect(results.textContent).toContain('—')
    expect(results.textContent).toContain('[WEB] Launch')
    expect(results.textContent).not.toContain('project #7')
    expect(results.querySelector('a')?.getAttribute('href')).toBe('/projects/7')
    expect(results.textContent).toContain('2 h')
    expect(results.textContent).toContain('2 entries cannot be priced')

    window.history.pushState(
      null,
      '',
      '/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31',
    )
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(results.textContent).toBe('')
    expect(results.hasAttribute('aria-busy')).toBe(false)
    expect(document.querySelector('[data-report-retry]')?.hasAttribute('hidden')).toBe(
      true,
    )
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'Your profile does not have access to this financial report.',
    )
  })

  it('[security] leaves the strip and the filters agreeing when a kind is denied', async () => {
    // The bookmark case: a member opens a financial report they can no longer
    // read. The denial itself is covered below; what this guards is that the
    // page does not contradict itself while denying. Before the fix, setKind
    // marked the Uninvoiced tab and the strip then removed it, leaving one
    // visible tab with no aria-current beside a filter card laid out for
    // uninvoiced — Client showing, Project optional — which is the exact
    // "which report am I looking at is invisible" failure #293 opens with.
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn()

    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('member'),
      new AbortController().signal,
      () => false,
    )

    const tabs = [...document.querySelectorAll('.tabstrip a[href^="/reports"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['My hours', 'Project budget'])
    // A surviving tab is the marked one, rather than nothing being marked. The
    // fallback is the personal report because it is the one that answers with
    // nothing else chosen.
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null])
    // ...and the filter card is dressed for that same report.
    expect(document.querySelector<HTMLElement>('[data-report-client-field]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector('[data-report-project-label]')?.textContent).toBe(
      'Project (optional)',
    )
    // The denial is unchanged: no request went out, and the reason is named.
    expect(getUninvoicedReport).not.toHaveBeenCalled()
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'Your profile does not have access to this financial report.',
    )
  })

  it('[security] denies an explicit financial report URL before an API request', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn()

    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('member'),
      new AbortController().signal,
      () => false,
    )

    expect(getUninvoicedReport).not.toHaveBeenCalled()
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'Your profile does not have access to this financial report.',
    )
    expect(document.querySelector('[data-report-results]')?.textContent).toBe('')
  })

  it('[browser] offers active projects by default and archived ones on request', async () => {
    // #495: 66 of the 78 projects on the reporting account are archived, so a
    // picker that lists every one of them buries the twelve somebody is looking
    // for. Archived work stays reportable, which is why this is the picker's
    // default and not a restriction on what can be asked for.
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const api = baseApi({
      listReportClients: vi.fn(async () =>
        page([client(1, 'Parent'), client(3, 'Wound down', { is_active: false })]),
      ),
      listReportProjects: vi.fn(async () =>
        page([
          project(7, 'Launch', { code: 'WEB', client_id: 2 }),
          project(8, 'Retired rebrand', { is_active: false }),
        ]),
      ),
    })
    const session = new AbortController()
    await createReportsController(api).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    const projectPicker = document.querySelector<HTMLSelectElement>('[data-report-project]')!
    const clientPicker = document.querySelector<HTMLSelectElement>('[data-report-client]')!
    const optionValues = (picker: HTMLSelectElement): string[] =>
      [...picker.options].map((choice) => choice.value)
    expect(optionValues(projectPicker)).toEqual(['', '7'])
    expect(optionValues(clientPicker)).toEqual(['', '1'])

    const catalog = document.querySelector<HTMLSelectElement>('[data-report-catalog]')!
    expect(catalog.value).toBe('active')
    catalog.value = 'all'
    catalog.dispatchEvent(new Event('change', { bubbles: true }))

    expect(optionValues(projectPicker)).toEqual(['', '7', '8'])
    expect(optionValues(clientPicker)).toEqual(['', '1', '3'])
    // Widened, the archived entries say so rather than passing for live work.
    expect([...projectPicker.options].map((choice) => choice.textContent)).toContain(
      'Retired rebrand (archived)',
    )
    // Only one catalog request each way: widening is a re-dress of what is
    // already in hand, not a second trip.
    expect(api.listReportProjects).toHaveBeenCalledTimes(1)
    session.abort()
  })

  it('[browser] keeps an archived project listed while its report is the one on screen', async () => {
    // The link out of the project directory, and the bookmark: the report is
    // this archived project's, so dropping its option would quietly retarget
    // the picker to "All projects" and disagree with the results underneath.
    writeDocument('/reports?report=project-budget&from=2026-08-01&to=2026-08-31&project_id=8')
    const getProjectBudgetReport = vi.fn(async () => ({
      project_id: 8,
      budget_by: 'project' as const,
      expenses_included: false,
      from: '2026-08-01',
      to: '2026-08-31',
      grains: [],
    }))
    const session = new AbortController()
    await createReportsController(
      baseApi({
        getProjectBudgetReport,
        listReportProjects: vi.fn(async () =>
          page([
            project(7, 'Launch', { code: 'WEB', client_id: 2 }),
            project(8, 'Retired rebrand', { is_active: false }),
          ]),
        ),
      }),
    ).activate(identity('administrator'), session.signal, () => false)

    const projectPicker = document.querySelector<HTMLSelectElement>('[data-report-project]')!
    expect(document.querySelector<HTMLSelectElement>('[data-report-catalog]')?.value).toBe(
      'active',
    )
    expect([...projectPicker.options].map((choice) => choice.value)).toEqual(['', '7', '8'])
    expect(projectPicker.value).toBe('8')
    expect(getProjectBudgetReport).toHaveBeenCalledWith(
      8,
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    session.abort()
  })

  it('[browser] exposes an accessible error retry and honest empty state', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi
      .fn()
      .mockRejectedValueOnce(new Error('Report service interrupted.'))
      .mockResolvedValueOnce({
        from: '2026-08-01',
        to: '2026-08-31',
        client_id: null,
        project_id: null,
        totals: [],
      })

    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    const status = document.querySelector<HTMLElement>('[data-report-status]')!
    const retry = document.querySelector<HTMLButtonElement>('[data-report-retry]')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe('Report service interrupted.')
    expect(retry.hidden).toBe(false)
    retry.click()
    await vi.waitFor(() => expect(getUninvoicedReport).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector('.report-empty')?.textContent).toContain(
        'No uninvoiced time or expenses',
      ),
    )
    expect(status.textContent).toBe('Report loaded.')
  })

  it('[browser] names the range the address already carried as a period', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [],
    }))
    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    // No period parameter was added to the address: a whole August is readable
    // as August from the dates alone.
    expect(document.querySelector('[data-period-summary]')?.textContent).toBe('August 2026')
    expect(document.querySelector<HTMLSelectElement>('[data-period-kind]')?.value).toBe('month')
    expect(document.querySelector<HTMLElement>('[data-period-custom]')?.hidden).toBe(true)
    // The two bare date fields the card used to carry are gone, not duplicated.
    expect(document.querySelector('[data-report-from]')).toBeNull()
    expect(document.querySelector('[data-report-to]')).toBeNull()
  })

  it('[browser] runs the previous period on the back arrow and puts it in the address', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [],
    }))
    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )
    expect(getUninvoicedReport).toHaveBeenCalledTimes(1)

    document.querySelector<HTMLButtonElement>('[data-period-previous]')!.click()
    await vi.waitFor(() => expect(getUninvoicedReport).toHaveBeenCalledTimes(2))
    expect(getUninvoicedReport).toHaveBeenLastCalledWith(
      { from: '2026-07-01', to: '2026-07-31' },
      expect.any(AbortSignal),
    )
    expect(window.location.search).toBe(
      '?report=uninvoiced&from=2026-07-01&to=2026-07-31',
    )
    expect(document.querySelector('[data-period-summary]')?.textContent).toBe('July 2026')

    // Back is the other half of stepping: the control has to follow the address
    // it lands on, or the label names a period the results below it are not.
    window.history.back()
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-period-summary]')?.textContent).toBe(
        'August 2026',
      ),
    )
    expect(getUninvoicedReport).toHaveBeenLastCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.any(AbortSignal),
    )
  })

  it('[browser] reads a whole week as a week under the organisation week start', async () => {
    // Saturday to Friday: a week only if the organisation starts on Saturday.
    writeDocument('/reports?report=uninvoiced&from=2025-04-12&to=2025-04-18')
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2025-04-12',
      to: '2025-04-18',
      client_id: null,
      project_id: null,
      totals: [],
    }))
    const getTimeEntrySettings = vi.fn(async () => ({
      time_entry_mode: 'duration' as const,
      time_format: 'decimal' as const,
      clock: '24h' as const,
      week_start_day: 'saturday' as const,
    }))
    await createReportsController(
      baseApi({ getUninvoicedReport, getTimeEntrySettings }),
    ).activate(identity('administrator'), new AbortController().signal, () => false)

    expect(document.querySelector<HTMLSelectElement>('[data-period-kind]')?.value).toBe('week')
    expect(document.querySelector('[data-period-summary]')?.textContent).toBe(
      '12 – 18 Apr 2025',
    )
    document.querySelector<HTMLButtonElement>('[data-period-previous]')!.click()
    await vi.waitFor(() => expect(getUninvoicedReport).toHaveBeenCalledTimes(2))
    expect(getUninvoicedReport).toHaveBeenLastCalledWith(
      { from: '2025-04-05', to: '2025-04-11' },
      expect.any(AbortSignal),
    )
  })

  it('[browser] still reports when the week-start setting cannot be read', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [],
    }))
    const getTimeEntrySettings = vi.fn().mockRejectedValue(new Error('settings unavailable'))
    await createReportsController(
      baseApi({ getUninvoicedReport, getTimeEntrySettings }),
    ).activate(identity('administrator'), new AbortController().signal, () => false)

    expect(getTimeEntrySettings).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-report-status]')?.textContent).toBe('Report loaded.')
    expect(document.querySelector('[data-period-summary]')?.textContent).toBe('August 2026')
  })

  it("[security] gives a member their own hours with no control that could ask for anyone else's", async () => {
    writeDocument('/reports?report=my-hours&from=2026-08-01&to=2026-08-31')
    const getMyHoursReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      user_id: 4,
      project_id: null,
      seconds: 9_000,
      rounded_seconds: 10_800,
      billable_seconds: 7_200,
      time_entry_count: 3,
      projects: [
        {
          project_id: 7,
          project_name: 'Launch',
          project_code: 'WEB',
          client_id: 2,
          client_name: 'Studio',
          seconds: 5_400,
          rounded_seconds: 7_200,
          billable_seconds: 7_200,
          time_entry_count: 2,
        },
        {
          project_id: 9,
          project_name: 'Internal',
          // The empty string, which is what a project with no code actually
          // carries -- `projects.code` is NOT NULL DEFAULT ''. Feeding null
          // here tested a response the API cannot produce, and let a label
          // reading `[] Internal` pass.
          project_code: '',
          client_id: 1,
          client_name: 'Parent',
          seconds: 3_600,
          rounded_seconds: 3_600,
          billable_seconds: 0,
          time_entry_count: 1,
        },
      ],
    }))
    const getUninvoicedReport = vi.fn()
    const session = new AbortController()

    await createReportsController(
      baseApi({ getMyHoursReport, getUninvoicedReport }),
    ).activate(identity('member'), session.signal, () => false)

    // The request carries a range and nothing else. There is no user argument
    // to send, so there is no request a member could edit into somebody else's
    // week -- the session decides whose hours come back.
    expect(getMyHoursReport).toHaveBeenCalledTimes(1)
    expect(getMyHoursReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    expect(getUninvoicedReport).not.toHaveBeenCalled()
    // And no person picker on the card that could suggest otherwise.
    expect(document.querySelector<HTMLElement>('[data-report-client-field]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector('[data-report-user]')).toBeNull()

    const results = document.querySelector('[data-report-results]')!
    expect(results.textContent).toContain('My hours')
    // Cell by cell, because tracked and rounded differ per row on an account
    // that rounds: a table that put the rounded figure in the tracked column
    // would still total correctly underneath and still be the wrong table.
    const cells = (row: Element): (string | null)[] =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent)
    expect([...results.querySelectorAll('tbody tr')].map(cells)).toEqual([
      ['Studio', '[WEB] Launch', '1.5 h', '2 h', '2 h', '2'],
      ['Parent', 'Internal', '1 h', '1 h', '0 h', '1'],
    ])
    expect([...results.querySelectorAll('tfoot tr')].map(cells)).toEqual([
      ['Total', '2.5 h', '3 h', '2 h', '3'],
    ])
    expect(results.querySelector('tbody tr th a')?.getAttribute('href')).toBe('/clients/2')
    // Tracked and rounded are both named above the table too.
    expect(results.textContent).toContain('Tracked time')
    expect(results.textContent).toContain('Rounded time')
    session.abort()
  })

  /**
   * One month, four foldings. The fixture deliberately differs on every axis a
   * fold could confuse: two clients with different hours, a project with a code
   * and one without, one employee and one contractor.
   */
  const timeReportFixture: TimeReport = {
    from: '2026-09-01',
    to: '2026-09-30',
    totals: {
      // Tracked and rounded deliberately differ: on an account that rounds
      // they are two numbers, and a column reading the wrong one is invisible
      // in a fixture where they agree.
      seconds: 34_200,
      rounded_seconds: 36_000,
      billable_seconds: 27_000,
      time_entry_count: 4,
      unpriced_billable_entry_count: 0,
      amounts: [{ currency: 'USD', billable_cents: 300_000, uninvoiced_cents: 120_000 }],
    },
    clients: [
      {
        client_id: 1,
        client_name: 'Parent',
        seconds: 25_200,
        rounded_seconds: 27_000,
        billable_seconds: 27_000,
        time_entry_count: 3,
        unpriced_billable_entry_count: 0,
        amounts: [{ currency: 'USD', billable_cents: 300_000, uninvoiced_cents: 120_000 }],
      },
      {
        client_id: 2,
        client_name: 'Studio',
        seconds: 9000,
        rounded_seconds: 9000,
        billable_seconds: 0,
        time_entry_count: 1,
        unpriced_billable_entry_count: 0,
        amounts: [],
      },
    ],
    projects: [
      {
        project_id: 7,
        project_name: 'Launch',
        project_code: 'WEB',
        client_id: 1,
        client_name: 'Parent',
        seconds: 25_200,
        rounded_seconds: 27_000,
        billable_seconds: 27_000,
        time_entry_count: 3,
        unpriced_billable_entry_count: 0,
        amounts: [{ currency: 'USD', billable_cents: 300_000, uninvoiced_cents: 120_000 }],
      },
      {
        project_id: 8,
        // A project with no code stores the empty string, never null.
        project_name: 'Internal',
        project_code: '',
        client_id: 2,
        client_name: 'Studio',
        seconds: 9000,
        rounded_seconds: 9000,
        billable_seconds: 0,
        time_entry_count: 1,
        unpriced_billable_entry_count: 0,
        amounts: [],
      },
    ],
    tasks: [
      {
        task_id: 1,
        task_name: 'Delivery',
        seconds: 25_200,
        rounded_seconds: 27_000,
        billable_seconds: 27_000,
        time_entry_count: 3,
        unpriced_billable_entry_count: 0,
        amounts: [{ currency: 'USD', billable_cents: 300_000, uninvoiced_cents: 120_000 }],
      },
      {
        task_id: 2,
        task_name: 'Admin',
        seconds: 9000,
        rounded_seconds: 9000,
        billable_seconds: 0,
        time_entry_count: 1,
        unpriced_billable_entry_count: 0,
        amounts: [],
      },
    ],
    teammates: [
      {
        user_id: 4,
        user_name: 'Ada Byron',
        is_contractor: true,
        capacity_seconds: 540_000,
        utilization_ppm: 50_000,
        seconds: 25_200,
        rounded_seconds: 27_000,
        billable_seconds: 27_000,
        time_entry_count: 3,
        unpriced_billable_entry_count: 0,
        amounts: [{ currency: 'USD', billable_cents: 300_000, uninvoiced_cents: 120_000 }],
      },
      {
        user_id: 5,
        user_name: 'Grace Hopper',
        is_contractor: false,
        capacity_seconds: 540_000,
        utilization_ppm: 16_667,
        seconds: 9000,
        rounded_seconds: 9000,
        billable_seconds: 0,
        time_entry_count: 1,
        unpriced_billable_entry_count: 0,
        amounts: [],
      },
    ],
  }

  /** Data rows only: the Employees / Contractors bands are not rows of data. */
  const dataRows = (): HTMLTableRowElement[] => [
    ...document.querySelectorAll<HTMLTableRowElement>(
      '[data-report-results] tbody tr:not(.report-group-row)',
    ),
  ]
  const headers = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[data-report-results] thead th')].map(
      (cell) => cell.textContent ?? '',
    )

  it('[browser] folds one Time response four ways and switches tabs without asking again', async () => {
    writeDocument('/reports?report=time&from=2026-09-01&to=2026-09-30')
    const getTimeReport = vi.fn(async () => timeReportFixture)
    const session = new AbortController()
    await createReportsController(baseApi({ getTimeReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )
    expect(getTimeReport).toHaveBeenCalledTimes(1)
    expect(getTimeReport).toHaveBeenCalledWith(
      { from: '2026-09-01', to: '2026-09-30' },
      expect.anything(),
    )

    const summary = document.querySelector<HTMLElement>('.report-summary')
    expect(summary, 'summary strip').not.toBeNull()
    // 10.00 rounded, 7.50 of it billable, so 2.50 is not. Rounded, not the
    // 9.50 tracked: this is the figure invoices and every other report count.
    expect(summary!.textContent).toContain('10 h')
    expect(summary!.textContent).not.toContain('9.5 h')
    expect(summary!.textContent).toContain('7.5 h')
    expect(summary!.textContent).toContain('2.5 h')
    expect(summary!.textContent).toContain('$3,000.00')
    expect(summary!.textContent).toContain('$1,200.00')

    // Clients is the tab a bare address lands on, and both clients are drawn:
    // counted first, so nothing below can pass against an empty table.
    expect(headers()).toEqual(['Name', 'Hours', '', 'Billable hours', 'Billable amount'])
    expect(dataRows()).toHaveLength(2)
    expect(dataRows()[0]!.textContent).toContain('Parent')
    // The Hours column is the rounded figure too, not the 7.00 tracked.
    expect(dataRows()[0]!.textContent).toContain('7.5 h')
    expect(dataRows()[0]!.textContent).not.toContain('7 h')
    expect(dataRows()[0]!.textContent).toContain('(100%)')
    expect(dataRows()[1]!.textContent).toContain('Studio')
    // No billable hours means no amount to state, not zero dollars.
    expect(dataRows()[1]!.textContent).toContain('—')

    const tab = (label: string): HTMLAnchorElement => {
      const found = [
        ...document.querySelectorAll<HTMLAnchorElement>('.report-subtabs a'),
      ].find((anchor) => anchor.textContent === label)
      if (found === undefined) throw new Error(`no ${label} sub-tab`)
      return found
    }
    expect(tab('Projects').getAttribute('href')).toBe(
      '/reports?report=time&from=2026-09-01&to=2026-09-30&tab=projects',
    )
    tab('Projects').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    // The four tabs are folds of the response already in hand, so switching
    // must not cost a request.
    expect(getTimeReport).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe(
      '?report=time&from=2026-09-01&to=2026-09-30&tab=projects',
    )
    expect(headers()).toEqual([
      'Name',
      'Clients',
      'Hours',
      '',
      'Billable hours',
      'Billable amount',
    ])
    expect(dataRows()).toHaveLength(2)
    expect(dataRows()[0]!.textContent).toContain('[WEB] Launch')
    // A project with no code renders as its bare name: projects.code is NOT
    // NULL DEFAULT '', so a null check alone would print "[] Internal".
    expect(dataRows()[1]!.textContent).toContain('Internal')
    expect(dataRows()[1]!.textContent).not.toContain('[]')

    tab('Teammates').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(getTimeReport).toHaveBeenCalledTimes(1)
    expect(headers()).toEqual([
      'Name',
      'Hours',
      '',
      'Billable hours',
      'Billable amount',
      'Utilization',
    ])
    const bands = [
      ...document.querySelectorAll<HTMLElement>('[data-report-results] .report-group-row'),
    ].map((row) => row.textContent)
    expect(bands).toEqual(['Employees', 'Contractors'])
    expect(dataRows()).toHaveLength(2)
    // The utilization the team roster would print for the same figure.
    expect(dataRows()[0]!.textContent).toContain('1.7%')
    expect(dataRows()[1]!.textContent).toContain('5%')

    tab('Tasks').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(dataRows()).toHaveLength(2)
    expect(dataRows()[0]!.textContent).toContain('Delivery')
    // The Total row totals the period, not the tab: it is the same figure on
    // all four.
    const total = document.querySelector<HTMLElement>('[data-report-results] tfoot tr')
    expect(total, 'total row').not.toBeNull()
    expect(total!.textContent).toContain('Total')
    expect(total!.textContent).toContain('10 h')
    expect(total!.textContent).toContain('$3,000.00')
    session.abort()
  })

  it('[security] links a teammate only where the viewer may open a person', async () => {
    // `reports:read` is accounting, executive_manager and administrator;
    // `team:read` is project_manager, people_admin, executive_manager and
    // administrator. Accounting sits in the first and not the second, so a
    // teammate row linked unconditionally hands them a link to a page the shell
    // keeps out of their nav and the Team screen refuses on arrival.
    const open = async (profile: 'administrator' | 'accounting') => {
      writeDocument('/reports?report=time&from=2026-09-01&to=2026-09-30&tab=teammates')
      const session = new AbortController()
      await createReportsController(
        baseApi({ getTimeReport: vi.fn(async () => timeReportFixture) }),
      ).activate(identity(profile), session.signal, () => false)
      const rows = dataRows()
      // Counted first: an empty table would satisfy both halves below.
      expect(rows.length, `${profile} teammate rows`).toBeGreaterThan(0)
      const result = {
        names: rows.map((row) => row.querySelector('th')?.textContent ?? ''),
        links: [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/team/"]')].length,
      }
      session.abort()
      return result
    }

    const asAdministrator = await open('administrator')
    expect(asAdministrator.links).toBeGreaterThan(0)

    const asAccounting = await open('accounting')
    // The names are still there -- this withholds the link, not the report.
    expect(asAccounting.names).toEqual(asAdministrator.names)
    expect(asAccounting.links).toBe(0)
  })

  it('[browser] opens on the tab the address names and drops the pickers the report has no axis for', async () => {
    writeDocument('/reports?report=time&from=2026-09-01&to=2026-09-30&tab=tasks')
    const session = new AbortController()
    await createReportsController(baseApi({ getTimeReport: vi.fn(async () => timeReportFixture) })).activate(
      identity('accounting'),
      session.signal,
      () => false,
    )
    expect(
      document.querySelector<HTMLAnchorElement>('.report-subtabs a[aria-current="page"]')
        ?.textContent,
    ).toBe('Tasks')
    expect(dataRows()[0]!.textContent).toContain('Delivery')
    // The Time report is the whole account over a period; narrowing it is what
    // the tabs inside it are for, so a client or project picker beside it would
    // promise an axis the endpoint does not take.
    expect(document.querySelector<HTMLElement>('[data-report-client-field]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-report-project-field]')?.hidden).toBe(true)
    // And with both pickers gone, the switch that widens them goes too.
    expect(document.querySelector<HTMLElement>('[data-report-catalog-field]')?.hidden).toBe(
      true,
    )
    session.abort()
  })

  it('[security] draws the hours and drops the amount columns when the response carries none', async () => {
    writeDocument('/reports?report=time&from=2026-09-01&to=2026-09-30')
    // What a viewer without billable-rate authority receives: every hours field
    // present and the `amounts` key absent, which is what the serializer does
    // -- an empty array would be a different claim, that the month held no
    // billable work.
    const stripAmounts = <Row extends object>(row: Row): Row => {
      const copy = { ...row } as Record<string, unknown>
      delete copy['amounts']
      return copy as Row
    }
    const withoutMoney: TimeReport = {
      ...timeReportFixture,
      totals: stripAmounts(timeReportFixture.totals),
      clients: timeReportFixture.clients.map(stripAmounts),
      projects: timeReportFixture.projects.map(stripAmounts),
      tasks: timeReportFixture.tasks.map(stripAmounts),
      teammates: timeReportFixture.teammates.map(stripAmounts),
    }
    const session = new AbortController()
    await createReportsController(
      baseApi({ getTimeReport: vi.fn(async () => withoutMoney) }),
    ).activate(identity('administrator'), session.signal, () => false)

    expect(dataRows()).toHaveLength(2)
    expect(headers()).toEqual(['Name', 'Hours', '', 'Billable hours'])
    const results = document.querySelector<HTMLElement>('[data-report-results]')!
    expect(results.textContent).toContain('10 h')
    expect(results.textContent).toContain('7.5 h')
    // No money anywhere -- not a column of dashes, which would say the month
    // had no billable value rather than that this reader may not see it.
    expect(results.textContent).not.toContain('$')
    expect(results.textContent).not.toContain('Billable amount')
    expect(results.textContent).not.toContain('Uninvoiced amount')
    session.abort()
  })

  it('[browser] counts unpriced billable hours in the hours and says they are out of the amounts', async () => {
    writeDocument('/reports?report=time&from=2026-09-01&to=2026-09-30')
    const session = new AbortController()
    await createReportsController(
      baseApi({
        getTimeReport: vi.fn(async () => ({
          ...timeReportFixture,
          totals: { ...timeReportFixture.totals, unpriced_billable_entry_count: 2 },
        })),
      }),
    ).activate(identity('administrator'), session.signal, () => false)
    const warning = document.querySelector<HTMLElement>('[data-report-results] .report-warning')
    expect(warning, 'unpriced warning').not.toBeNull()
    expect(warning!.textContent).toContain('2 billable time entries')
    expect(warning!.textContent).toContain('excluded from the amounts')
    session.abort()
  })

  it('[browser] narrows my hours to a chosen project and says so in the address', async () => {
    writeDocument('/reports?report=my-hours&from=2026-08-01&to=2026-08-31')
    const getMyHoursReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      user_id: 4,
      project_id: 7,
      seconds: 0,
      rounded_seconds: 0,
      billable_seconds: 0,
      time_entry_count: 0,
      projects: [],
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getMyHoursReport })).activate(
      identity('member'),
      session.signal,
      () => false,
    )
    expect(getMyHoursReport).toHaveBeenCalledTimes(1)

    document.querySelector<HTMLSelectElement>('[data-report-project]')!.value = '7'
    document.querySelector<HTMLFormElement>('[data-report-form]')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() => expect(getMyHoursReport).toHaveBeenCalledTimes(2))

    expect(getMyHoursReport).toHaveBeenLastCalledWith(
      { from: '2026-08-01', to: '2026-08-31', project_id: 7 },
      expect.anything(),
    )
    expect(window.location.search).toBe(
      '?report=my-hours&from=2026-08-01&to=2026-08-31&project_id=7',
    )
    expect(document.querySelector('[data-report-results]')?.textContent).toContain(
      'You logged no time in this period.',
    )
    session.abort()
  })

  it('[browser] totals contractor cost inside each currency and prices no uncosted row', async () => {
    // #519. The row shape is the whole test: a cost that is null is not a cost
    // of zero, the count behind that null is the only way a reader can see
    // which rows are incomplete, and two rows for one person in two currencies
    // are two answers rather than one that can be added.
    writeDocument('/reports?report=contractor-cost&from=2026-08-01&to=2026-08-31')
    const getContractorCostReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      rows: [
        {
          user_id: 11,
          name: 'Ada Wren',
          payroll_email: 'ada@example.test',
          is_contractor: true,
          currency: 'USD',
          rounded_seconds: 144_000,
          cost_cents: 400_000,
          entries_without_rate: 0,
        },
        {
          user_id: 12,
          name: 'Grace Hall',
          payroll_email: null,
          is_contractor: false,
          currency: 'USD',
          rounded_seconds: 36_000,
          cost_cents: null,
          entries_without_rate: 3,
        },
        {
          user_id: 11,
          name: 'Ada Wren',
          payroll_email: 'ada@example.test',
          is_contractor: true,
          currency: 'EUR',
          rounded_seconds: 7_200,
          cost_cents: 20_000,
          entries_without_rate: 0,
        },
      ],
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getContractorCostReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    // The range is the entire request: no client, no project, nothing that
    // could narrow a report the endpoint answers whole.
    expect(getContractorCostReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    const results = document.querySelector('[data-report-results]')!
    // Counted before anything is read off them, so a fixture that rendered
    // nothing cannot pass this test by finding nothing wrong.
    const sections = results.querySelectorAll('.report-cost-currency')
    expect(sections.length).toBe(2)
    const [usd, eur] = [...sections]
    expect(usd!.querySelector('h3')?.textContent).toBe('USD')
    expect(eur!.querySelector('h3')?.textContent).toBe('EUR')
    expect(usd!.querySelectorAll('tbody tr').length).toBe(2)
    expect(eur!.querySelectorAll('tbody tr').length).toBe(1)

    const usdRows = [...usd!.querySelectorAll('tbody tr')]
    expect(usdRows[0]!.querySelector('a')?.getAttribute('href')).toBe('/team/11')
    expect(usdRows[0]!.textContent).toContain('Contractor')
    expect(usdRows[0]!.querySelectorAll('td')[0]?.textContent).toBe('40 h')
    expect(usdRows[0]!.querySelectorAll('td')[1]?.textContent).toBe('$4,000.00')

    // Ten hours with no rate behind them. Neither a zero nor a bare dash: both
    // read as "nothing to pay" for work that was done.
    const uncosted = usdRows[1]!.querySelectorAll('td')[1]!
    expect(uncosted.textContent).toContain('Not costed')
    expect(uncosted.textContent).toContain('3 entries without a cost rate')
    expect(uncosted.textContent).not.toContain('0.00')
    expect(usdRows[1]!.textContent).toContain('Employee')

    // Hours still total -- seconds carry no rate -- but the currency's cost
    // does not, because one of its rows has no cost at all.
    const usdTotal = usd!.querySelectorAll('tfoot td')
    expect(usdTotal[0]?.textContent).toBe('50 h')
    expect(usdTotal[1]?.textContent).toBe('Not costed')
    expect(usd!.querySelector('.report-warning')?.textContent).toBe(
      '3 entries across 1 person have no cost rate, so USD has no total.',
    )

    const eurTotal = eur!.querySelectorAll('tfoot td')
    expect(eurTotal[0]?.textContent).toBe('2 h')
    expect(eurTotal[1]?.textContent).toBe('€200.00')
    expect(eur!.querySelector('.report-warning')).toBeNull()
    // The same person is in both sections and is never added across them: 42
    // hours and a combined figure are the two shapes of that mistake.
    expect(results.textContent).not.toContain('42 h')
    expect(results.textContent).not.toContain('4,200.00')
    session.abort()
  })

  it('[security] keeps the cost report to the administrator, not the financial profiles', async () => {
    // Stricter than the other financial kinds on purpose: cost_rate is
    // administrator-only in canViewMoneyField, and the route refuses on that
    // same call. An accounting profile that saw the tab would get a 403.
    writeDocument('/reports?report=contractor-cost&from=2026-08-01&to=2026-08-31')
    const getContractorCostReport = vi.fn()

    await createReportsController(baseApi({ getContractorCostReport })).activate(
      identity('accounting'),
      new AbortController().signal,
      () => false,
    )

    const tabs = [...document.querySelectorAll('.tabstrip a[href^="/reports"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'My hours',
      'Time',
      'Uninvoiced work',
      'Detailed time',
      'Detailed expense',
      'Client rollup',
      'Activity log',
      'Project budget',
    ])
    expect(getContractorCostReport).not.toHaveBeenCalled()
    // The refusal names the profile that can, rather than repeating the
    // financial-report wording accounting has already satisfied.
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'Only an administrator can read the contractor cost report.',
    )
    expect(document.querySelector('[data-report-results]')?.textContent).toBe('')
    // The strip and the card agree on what is being looked at instead: the
    // surviving fallback kind is marked, and its filters are the ones shown.
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([
      'page',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    expect(document.querySelector<HTMLElement>('[data-report-client-field]')?.hidden).toBe(
      true,
    )
  })

  it('[browser] asks for the cost report with the range alone and hides both pickers', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31&client_id=1')
    const getContractorCostReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      rows: [],
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getContractorCostReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    const tab = [
      ...document.querySelectorAll<HTMLAnchorElement>('.tabstrip a[href^="/reports"]'),
    ].at(-1)!
    expect(tab.textContent).toBe('Contractor cost')
    // Neither id follows the kind into the address: the endpoint takes neither.
    expect(tab.getAttribute('href')).toBe(
      '/reports?report=contractor-cost&from=2026-08-01&to=2026-08-31',
    )
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(getContractorCostReport).toHaveBeenCalledTimes(1))

    expect(getContractorCostReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/reports?report=contractor-cost&from=2026-08-01&to=2026-08-31',
    )
    expect(document.querySelector<HTMLElement>('[data-report-client-field]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector<HTMLElement>('[data-report-project-field]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector('[data-report-results]')?.textContent).toContain(
      'Nobody tracked time in this period.',
    )
    session.abort()
  })
  const detailedFixture = (): DetailedTimeReport =>
    detailedTimeReport({
      seconds: 6_300,
      rounded_seconds: 6_300,
      billable_seconds: 5_400,
      uninvoiced_billable_seconds: 5_400,
      time_entry_count: 4,
      currencies: [
        { currency: 'USD', billable_amount_cents: 15_000, entries_without_billable_rate: 0 },
      ],
      rows: [
        detailedTimeRow(),
        detailedTimeRow({
          user_id: 2,
          user_name: 'Grace Hopper',
          seconds: 1_800,
          roles: [],
        }),
        detailedTimeRow({ spent_date: '2026-08-11', seconds: 900 }),
      ],
    })

  it('[browser] draws the detailed report with its filter recap, bands and total', async () => {
    writeDocument('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&client_id=2')
    const getDetailedTimeReport = vi.fn(async () => ({
      ...detailedFixture(),
      client_id: 2,
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getDetailedTimeReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    const results = document.querySelector('[data-report-results]')!
    expect(getDetailedTimeReport).toHaveBeenCalledTimes(1)
    expect(results.querySelector('h2')?.textContent).toBe(
      'Detailed time report: 2026-08-01 – 2026-08-31',
    )

    // The recap is counted before it is read: a four-line list that rendered
    // empty would otherwise satisfy every assertion below it.
    const recap = results.querySelector('.report-filter-recap')!
    expect(recap.querySelectorAll('dt')).toHaveLength(4)
    expect([...recap.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Clients',
      'Projects',
      'Tasks',
      'Team',
    ])
    expect([...recap.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
      'Studio',
      'All projects',
      'All tasks',
      'All people',
    ])

    const bands = results.querySelectorAll('.report-band-row')
    expect(bands).toHaveLength(2)
    expect([...bands].map((band) => band.querySelector('th')?.textContent)).toEqual([
      '2026-08-10',
      '2026-08-11',
    ])
    expect(results.querySelectorAll('tbody tr:not(.report-band-row)')).toHaveLength(3)
    expect(results.querySelector('tfoot td')?.textContent).toBe('1.75')
    // Uninvoiced billable hours leads the summary, and is not the total.
    expect(results.querySelector('.report-facts')?.textContent).toContain('1.5 h')
    session.abort()
  })

  it('[browser] regroups the rows it already has without asking the API again', async () => {
    writeDocument('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31')
    const getDetailedTimeReport = vi.fn(async () => detailedFixture())
    const session = new AbortController()
    await createReportsController(baseApi({ getDetailedTimeReport })).activate(
      identity('accounting'),
      session.signal,
      () => false,
    )
    const results = document.querySelector('[data-report-results]')!
    expect(getDetailedTimeReport).toHaveBeenCalledTimes(1)
    expect(results.querySelectorAll('.report-band-row')).toHaveLength(2)

    const group = document.querySelector<HTMLSelectElement>('#ez-detailed-group')!
    group.value = 'person'
    group.dispatchEvent(new Event('change'))

    const bands = results.querySelectorAll('.report-band-row')
    expect(bands).toHaveLength(2)
    expect([...bands].map((band) => band.querySelector('th')?.textContent)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ])
    // Group by changes the table's shape, not its data: no second request, and
    // the same three rows are still on screen.
    expect(getDetailedTimeReport).toHaveBeenCalledTimes(1)
    expect(results.querySelectorAll('tbody tr:not(.report-band-row)')).toHaveLength(3)
    expect(window.location.search).toContain('group=person')
    session.abort()
  })

  it('[browser] goes back to the API when Show or Active projects only changes', async () => {
    writeDocument('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31')
    const getDetailedTimeReport = vi.fn(async () => detailedFixture())
    const session = new AbortController()
    await createReportsController(baseApi({ getDetailedTimeReport })).activate(
      identity('accounting'),
      session.signal,
      () => false,
    )
    expect(getDetailedTimeReport).toHaveBeenCalledWith(
      {
        from: '2026-08-01',
        to: '2026-08-31',
        hours: 'all',
        active_projects_only: false,
      },
      expect.anything(),
    )

    const show = document.querySelector<HTMLSelectElement>('#ez-detailed-hours')!
    show.value = 'uninvoiced'
    show.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(getDetailedTimeReport).toHaveBeenCalledTimes(2))
    expect(getDetailedTimeReport).toHaveBeenLastCalledWith(
      {
        from: '2026-08-01',
        to: '2026-08-31',
        hours: 'uninvoiced',
        active_projects_only: false,
      },
      expect.anything(),
    )

    const active = document.querySelector<HTMLInputElement>('#ez-detailed-active')!
    active.checked = true
    active.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(getDetailedTimeReport).toHaveBeenCalledTimes(3))
    expect(getDetailedTimeReport).toHaveBeenLastCalledWith(
      {
        from: '2026-08-01',
        to: '2026-08-31',
        hours: 'uninvoiced',
        active_projects_only: true,
      },
      expect.anything(),
    )
    session.abort()
  })

  it('[security] exports the rows on screen and nothing the API withheld', async () => {
    writeDocument('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31')
    // A member-shaped response: no `billable_amount_cents` on any row, so the
    // export has no money column to fill and no request that could fetch one.
    const withheld = detailedFixture().rows.map((row) => {
      const copy = { ...row }
      delete copy.billable_amount_cents
      return copy
    })
    const getDetailedTimeReport = vi.fn(async () => ({
      ...detailedFixture(),
      currencies: [{ currency: 'USD', entries_without_billable_rate: 0 }],
      rows: withheld,
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getDetailedTimeReport })).activate(
      identity('accounting'),
      session.signal,
      () => false,
    )

    const blobs: Blob[] = []
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return 'blob:report'
    })
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    document.querySelector<HTMLButtonElement>('[data-detailed-export]')!.click()

    expect(click).toHaveBeenCalledTimes(1)
    expect(blobs).toHaveLength(1)
    const csv = await blobs[0]!.text()
    expect(csv.split('\r\n')[0]).toBe(
      '"Date","Client","Project","Task","Roles","Person","Hours"',
    )
    expect(csv).toContain('"[WEB] Launch"')
    expect(csv).not.toContain('Billable amount')
    // Three rows on screen, plus the header and the total, and nothing else.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(5)
    // The API was asked once, for the report itself. Export never asks again.
    expect(getDetailedTimeReport).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report')

    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
    click.mockRestore()
    session.abort()
  })

  it('[browser #519] draws the activity log newest first over the range alone', async () => {
    writeDocument('/reports?report=activity-log&from=2026-08-01&to=2026-08-31')
    // Deliberately out of order on the wire, and the middle one back-dated, so
    // a renderer that trusted the response order would show these three in a
    // different sequence than the column of times reads.
    const getActivityLog = vi.fn(async () => [
      {
        event_id: 'b',
        event_type: 'invoice.payment.recorded',
        occurred_at: '2026-08-14T09:30:00.000Z',
        aggregate: { type: 'invoice', id: 1314, sequence: 41 },
        payload: {},
      },
      {
        event_id: 'a',
        event_type: 'invoice.sent',
        occurred_at: '2026-08-20T17:05:00.000Z',
        aggregate: { type: 'invoice', id: 1315, sequence: 42 },
        payload: {},
      },
      {
        event_id: 'c',
        event_type: 'timesheet_approved',
        occurred_at: '2026-08-02T08:00:00.000Z',
        aggregate: { type: 'timesheet', id: 9, sequence: 12 },
        payload: {},
      },
    ])
    const session = new AbortController()
    await createReportsController(baseApi({ getActivityLog })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    // The range is the whole request: the endpoint takes no client or project,
    // and a picker it would ignore is worse than no picker.
    expect(getActivityLog).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    expect(document.querySelector<HTMLElement>('[data-report-client-field]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-report-project-field]')?.hidden).toBe(true)

    const rows = [...document.querySelectorAll('[data-report-results] tbody tr')]
    // Counted first, so a fixture that drew nothing cannot pass by finding
    // nothing wrong.
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('time')?.getAttribute('datetime'))).toEqual([
      '2026-08-20T17:05:00.000Z',
      '2026-08-14T09:30:00.000Z',
      '2026-08-02T08:00:00.000Z',
    ])
    const cells = [...rows[0]!.querySelectorAll('td')].map((cell) => cell.textContent)
    // Built from the wire value, so an event nobody taught this screen about
    // still reads as words rather than a raw dotted string.
    expect(cells).toEqual(['Invoice sent', 'Invoice #1315'])
    expect(
      [...rows[2]!.querySelectorAll('td')].map((cell) => cell.textContent),
    ).toEqual(['Timesheet approved', 'Timesheet #9'])
  })

  it('[security] keeps the activity log off a member\u2019s tab strip', async () => {
    writeDocument('/reports?report=activity-log&from=2026-08-01&to=2026-08-31')
    const getActivityLog = vi.fn(async () => [])
    const session = new AbortController()
    await createReportsController(baseApi({ getActivityLog })).activate(
      identity('member'),
      session.signal,
      () => false,
    )

    // The log is not money, but it is the whole account's history, and a member
    // reads their own hours and nothing else in this section.
    expect(getActivityLog).not.toHaveBeenCalled()
    expect(
      [...document.querySelectorAll('[data-shell-tab]')].some((tab) =>
        tab.textContent?.includes('Activity log'),
      ),
    ).toBe(false)
  })

  it('[browser #519] leads with the worst margin and blanks what cannot be stated', async () => {
    writeDocument('/reports?report=profitability&from=2026-08-01&to=2026-08-31')
    const getProfitabilityReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      organization_currency: 'USD',
      rows: [
        // Healthy, and deliberately first on the wire so a renderer that kept
        // the response order would lead with the wrong project.
        {
          project_id: 7, project_name: 'Launch', project_code: 'WEB',
          client_id: 1, client_name: 'Parent', currency: 'USD',
          rounded_seconds: 3600, revenue_cents: 10_000, cost_cents: 4_000,
          profit_cents: 6_000,
          entries_without_billable_rate: 0, entries_without_cost_rate: 0,
        },
        // Losing money: this is what the report is opened to find.
        {
          project_id: 8, project_name: 'Rescue', project_code: '',
          client_id: 1, client_name: 'Parent', currency: 'USD',
          rounded_seconds: 7200, revenue_cents: 5_000, cost_cents: 9_000,
          profit_cents: -4_000,
          entries_without_billable_rate: 0, entries_without_cost_rate: 0,
        },
        // Bills in EUR: both sides real, margin unstateable.
        {
          project_id: 9, project_name: 'Continental', project_code: 'CONT',
          client_id: 2, client_name: 'Studio', currency: 'EUR',
          rounded_seconds: 3600, revenue_cents: 20_000, cost_cents: 4_000,
          profit_cents: null,
          entries_without_billable_rate: 0, entries_without_cost_rate: 0,
        },
      ],
      totals: {
        rounded_seconds: 14_400, revenue_cents: 15_000, cost_cents: 13_000,
        profit_cents: 2_000, entries_without_billable_rate: 0,
        entries_without_cost_rate: 0, projects_not_converted: 1,
      },
      previous_from: '2026-07-01',
      previous_to: '2026-07-31',
      previous_totals: {
        rounded_seconds: 7200, revenue_cents: 10_000, cost_cents: 9_000,
        profit_cents: 1_000, entries_without_billable_rate: 0,
        entries_without_cost_rate: 0, projects_not_converted: 0,
      },
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getProfitabilityReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    expect(getProfitabilityReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    const rows = [...document.querySelectorAll('[data-report-results] tbody tr')]
    expect(rows).toHaveLength(3)
    // Worst first, blank margin last: a project whose margin is a question
    // sorts after every project that has an answer.
    expect(rows.map((row) => row.querySelector('th a')?.textContent)).toEqual([
      'Rescue',
      '[WEB] Launch',
      '[CONT] Continental',
    ])
    // The EUR row shows both sides and no margin -- an em dash, not a number.
    const continental = [...rows[2]!.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(continental[2]).toBe('\u20ac200.00')
    // Cost is the organization's currency on the same line, deliberately.
    expect(continental[3]).toBe('$40.00')
    expect(continental[4]).toBe('\u2014')

    // Profit 2,000 against 1,000 the window before is +100%.
    const deltas = [...document.querySelectorAll('.report-profit-delta')].map(
      (node) => node.textContent,
    )
    expect(deltas).toEqual(['+50%', '+44.4%', '+100%'])

    const warnings = [...document.querySelectorAll('.report-warning')].map(
      (node) => node.textContent ?? '',
    )
    // It says how much of the account the headline leaves out, so a partial
    // total cannot be read as the whole firm.
    expect(warnings.some((text) => text.includes('1 project bills in another currency'))).toBe(
      true,
    )
  })

  it('[security] keeps profitability to the administrator, not the financial profiles', async () => {
    for (const profile of ['accounting', 'executive_manager'] as const) {
      writeDocument('/reports?report=profitability&from=2026-08-01&to=2026-08-31')
      const getProfitabilityReport = vi.fn(async () => ({
        from: '2026-08-01', to: '2026-08-31', organization_currency: 'USD',
        rows: [], totals: emptyProfitTotals,
        previous_from: '2026-07-01', previous_to: '2026-07-31',
        previous_totals: emptyProfitTotals,
      }))
      const session = new AbortController()
      await createReportsController(baseApi({ getProfitabilityReport })).activate(
        identity(profile),
        session.signal,
        () => false,
      )

      // A margin is the cost figure with one subtraction applied, so a profile
      // refused the cost report is refused this one on the same authority.
      expect(getProfitabilityReport, profile).not.toHaveBeenCalled()
      expect(document.querySelector('[data-report-status]')?.textContent).toBe(
        'Only an administrator can read the profitability report.',
      )
      expect(
        [...document.querySelectorAll('[data-shell-tab]')].some((tab) =>
          tab.textContent?.includes('Profitability'),
        ),
        profile,
      ).toBe(false)
      session.abort()
    }
  })

  it('[browser #519] lists expenses and keeps each currency to its own total', async () => {
    writeDocument('/reports?report=detailed-expense&from=2026-08-01&to=2026-08-31')
    const getDetailedExpenseReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      billable_only: false,
      totals: [
        { currency: 'USD', expense_count: 2, total_cost_cents: 3_500 },
        { currency: 'EUR', expense_count: 1, total_cost_cents: 9_000 },
      ],
      rows: [
        {
          expense_id: 201, spent_date: '2026-08-13', client_id: 1, client_name: 'Parent',
          project_id: 7, project_name: 'Launch', project_code: 'WEB',
          category_id: 1, category_name: 'Travel', user_id: 1, user_name: 'Ada Byron',
          notes: null, units: null, billable: true, reimbursable: false,
          invoice_id: null, currency: 'USD', total_cost_cents: 2_500,
        },
        {
          expense_id: 202, spent_date: '2026-08-11', client_id: 1, client_name: 'Parent',
          project_id: 7, project_name: 'Launch', project_code: 'WEB',
          category_id: 2, category_name: 'Software', user_id: 1, user_name: 'Ada Byron',
          notes: null, units: null, billable: false, reimbursable: true,
          invoice_id: null, currency: 'USD', total_cost_cents: 1_000,
        },
        {
          expense_id: 203, spent_date: '2026-08-09', client_id: 2, client_name: 'Studio',
          project_id: 9, project_name: 'Continental', project_code: '',
          category_id: 1, category_name: 'Travel', user_id: 1, user_name: 'Ada Byron',
          notes: null, units: null, billable: true, reimbursable: false,
          invoice_id: null, currency: 'EUR', total_cost_cents: 9_000,
        },
      ],
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getDetailedExpenseReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    expect(getDetailedExpenseReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    const rows = [...document.querySelectorAll('[data-report-results] tbody tr')]
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('th')?.textContent)).toEqual([
      '2026-08-13',
      '2026-08-11',
      '2026-08-09',
    ])
    // Each amount in the currency of its own expense, never relabelled.
    const amounts = rows.map((row) => row.querySelectorAll('td')[4]?.textContent)
    expect(amounts).toEqual(['$25.00', '$10.00', '\u20ac90.00'])
    // Non-billable and reimbursable are facts about the expense, not money, and
    // sit beside the category rather than in the amount column.
    expect(rows[1]!.querySelectorAll('td')[2]?.textContent).toContain('Non-billable')
    expect(rows[1]!.querySelectorAll('td')[2]?.textContent).toContain('Reimbursable')

    // Two currencies, two totals, never one figure over both.
    const summary = document.querySelector('.report-expense-totals')?.textContent ?? ''
    expect(summary).toContain('2 expenses')
    expect(summary).toContain('$35.00')
    expect(summary).toContain('1 expense ')
    expect(summary).toContain('\u20ac90.00')
    expect(summary).not.toContain('$125.00')
    session.abort()
  })

  it('[browser #534] names the uninvoiced figure for the three filters that made it', async () => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      totals: [
        {
          currency: 'USD',
          rounded_seconds: 3_245_256,
          time_entry_count: 120,
          unpriced_time_entry_count: 0,
          expense_count: 2,
          time_cents: 500_000,
          expense_cents: 1_000,
          total_cents: 501_000,
        },
      ],
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('administrator'),
      session.signal,
      () => false,
    )

    const results = document.querySelector('[data-report-results]')!
    // The figure is the generation preview -- billable, uninvoiced, active
    // projects -- so calling it tracked time reads as hours the migration lost.
    expect(results.textContent).toContain('Uninvoiced billable time')
    expect(results.textContent).not.toContain('Tracked time')
    // And the card says which hours it counted, since that is the whole reason
    // the number differs from the one being compared against.
    const note = results.querySelector('.report-card-note')?.textContent ?? ''
    expect(note).toContain('not yet invoiced')
    expect(note).toContain('active projects')
    session.abort()
  })
})
