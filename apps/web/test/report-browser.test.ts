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
    const from = document.querySelector<HTMLInputElement>('[data-report-from]')!
    const to = document.querySelector<HTMLInputElement>('[data-report-to]')!
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

    document.querySelector<HTMLInputElement>('[data-report-from]')!.value = '2026-09-02'
    document.querySelector<HTMLInputElement>('[data-report-to]')!.value = '2026-09-01'
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
      'Uninvoiced work',
      'Client rollup',
      'Project budget',
    ])
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null, null])
    // Every tab is a real address, and it carries the range being looked at.
    expect(tabs[1]?.getAttribute('href')).toBe(
      '/reports?report=client-rollup&from=2026-08-01&to=2026-08-31',
    )

    document.querySelector<HTMLSelectElement>('[data-report-client]')!.value = '1'
    tabs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(getClientRollupReport).toHaveBeenCalledTimes(1))
    expect(getClientRollupReport).toHaveBeenCalledWith(
      1,
      { from: '2026-08-01', to: '2026-08-31' },
      expect.anything(),
    )
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/reports?report=client-rollup&from=2026-08-01&to=2026-08-31&client_id=1',
    )
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, 'page', null])
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
    ).toEqual(['Project budget'])
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
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Project budget'])
    // The surviving tab is the marked one, rather than nothing being marked.
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page'])
    // ...and the filter card is dressed for that same report.
    expect(document.querySelector<HTMLElement>('[data-report-client-field]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector('[data-report-project-label]')?.textContent).toBe(
      'Project',
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
})
