/** @vitest-environment happy-dom */

import type { GeneralResource, Whoami } from '@ezacto/client'
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
  ...overrides,
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
      'Uninvoiced work',
      'Client rollup',
      'Project budget',
    ])
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([
      null,
      'page',
      null,
      null,
    ])
    // Every tab is a real address, and it carries the range being looked at.
    expect(tabs[2]?.getAttribute('href')).toBe(
      '/reports?report=client-rollup&from=2026-08-01&to=2026-08-31',
    )

    document.querySelector<HTMLSelectElement>('[data-report-client]')!.value = '1'
    tabs[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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
      'page',
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
})
