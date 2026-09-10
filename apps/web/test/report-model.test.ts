import type { EzactoClient, Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import {
  canReadFinancialReports,
  createShellApi,
  formatReportCents,
  formatReportHours,
  formatReportMoney,
  reportFiltersFromUrl,
  reportFiltersUrl,
  validateReportFilters,
} from '../src/index.js'

describe('Reports Stage 1 model', () => {
  it('[unit] keeps report selection and relevant filters in canonical URL state', () => {
    const filters = reportFiltersFromUrl(
      new URL(
        'https://example.test/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31&client_id=3&project_id=9',
      ),
      '2026-09-01',
    )
    expect(filters).toEqual({
      kind: 'uninvoiced',
      from: '2026-08-01',
      to: '2026-08-31',
      clientId: 3,
      projectId: 9,
    })
    expect(reportFiltersUrl(filters)).toBe(
      '/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31&client_id=3&project_id=9',
    )
    // A profile without the financial reports lands on its own hours: the one
    // kind that answers without a client or project chosen first.
    expect(
      reportFiltersFromUrl(new URL('https://example.test/reports'), '2026-09-17', false),
    ).toMatchObject({ kind: 'my-hours', from: '2026-09-01', to: '2026-09-17' })
    expect(
      reportFiltersUrl({
        kind: 'my-hours',
        from: '2026-09-01',
        to: '2026-09-17',
        clientId: 4,
        projectId: 9,
      }),
      // The project narrows it; the client does not, because the endpoint has
      // no client axis and a URL carrying one would imply it did.
    ).toBe('/reports?report=my-hours&from=2026-09-01&to=2026-09-17&project_id=9')
    expect(
      reportFiltersFromUrl(
        new URL('https://example.test/reports?from=not-a-date&to=2026-09-17&client_id=nope'),
        '2026-09-17',
      ),
    ).toMatchObject({ from: 'not-a-date', clientId: -1 })
  })

  it('[unit] rejects impossible, inverted, and incomplete report ranges', () => {
    expect(
      validateReportFilters({
        kind: 'uninvoiced',
        from: '2026-02-30',
        to: '2026-03-01',
        clientId: null,
        projectId: null,
      }),
    ).toContain('valid')
    expect(
      validateReportFilters({
        kind: 'client-rollup',
        from: '2026-09-02',
        to: '2026-09-01',
        clientId: 1,
        projectId: null,
      }),
    ).toContain('on or after')
    expect(
      validateReportFilters({
        kind: 'project-budget',
        from: '2026-09-01',
        to: '2026-09-01',
        clientId: null,
        projectId: null,
      }),
    ).toBe('Choose a project.')
  })

  it('[security] maps financial report access to the reports:read profile ceiling', () => {
    const allowed: Whoami['profile'][] = ['accounting', 'executive_manager', 'administrator']
    const all: Whoami['profile'][] = [
      'member',
      'project_manager',
      'people_admin',
      ...allowed,
    ]
    expect(all.filter(canReadFinancialReports)).toEqual(allowed)
  })

  it('[unit] never renders absent money as a confident zero and keeps time units explicit', () => {
    expect(formatReportMoney(undefined, 'USD')).toBe('—')
    expect(formatReportMoney(null, 'USD')).toBe('—')
    expect(formatReportMoney(0, 'USD')).toBe('$0.00')
    expect(formatReportMoney(12_345, 'EUR')).toBe('€123.45')
    expect(formatReportHours(5_400)).toBe('1.5 h')
    expect(formatReportHours(undefined)).toBe('—')
    expect(formatReportCents(12_345)).toBe('12,345 cents')
    expect(formatReportCents(undefined)).toBe('—')
  })

  it('[unit] maps catalogs and all four reports to generated-client operations', async () => {
    const page = { data: [], links: {}, page: { next_cursor: null } }
    const generated = {
      listClients: vi.fn(async () => page),
      listProjects: vi.fn(async () => page),
      getUninvoicedReport: vi.fn(async () => ({ data: { totals: [] } })),
      getClientRollupReport: vi.fn(async () => ({ data: { nodes: [] } })),
      getProjectBudgetReport: vi.fn(async () => ({ data: { grains: [] } })),
      getMyHoursReport: vi.fn(async () => ({ data: { projects: [] } })),
    }
    const api = createShellApi(generated as unknown as EzactoClient)
    const signal = new AbortController().signal

    await api.listReportClients!('clients-next', signal)
    await api.listReportProjects!('projects-next', signal)
    await api.getUninvoicedReport!({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: 3,
      project_id: 7,
    }, signal)
    await api.getClientRollupReport!(3, { from: '2026-08-01', to: '2026-08-31' }, signal)
    await api.getProjectBudgetReport!(7, { from: '2026-08-01', to: '2026-08-31' }, signal)
    await api.getMyHoursReport!({ from: '2026-08-01', to: '2026-08-31' }, signal)

    expect(generated.listClients).toHaveBeenCalledWith({
      query: { per_page: 200, cursor: 'clients-next' },
      signal,
    })
    expect(generated.listProjects).toHaveBeenCalledWith({
      query: { per_page: 200, cursor: 'projects-next' },
      signal,
    })
    expect(generated.getUninvoicedReport).toHaveBeenCalledWith({
      query: {
        from: '2026-08-01',
        to: '2026-08-31',
        client_id: 3,
        project_id: 7,
      },
      signal,
    })
    expect(generated.getClientRollupReport).toHaveBeenCalledWith({
      clientId: 3,
      query: { from: '2026-08-01', to: '2026-08-31' },
      signal,
    })
    expect(generated.getProjectBudgetReport).toHaveBeenCalledWith({
      projectId: 7,
      query: { from: '2026-08-01', to: '2026-08-31' },
      signal,
    })
    // Nothing identifies the person: the session the request is made on does.
    expect(generated.getMyHoursReport).toHaveBeenCalledWith({
      query: { from: '2026-08-01', to: '2026-08-31' },
      signal,
    })
  })
})
