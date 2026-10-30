import { vi } from 'vitest'
import type { DetailedTimeReport, DetailedTimeRow, GeneralResource, TimeReport, Whoami } from '@conflict-hq/ezacto-client'
import type { ReportWorkspaceApi } from '../../src/reports/model.js'
import { renderAppShell, reportKindTabs } from '../../src/index.js'

export const timestamp = '2026-09-01T12:00:00.000Z'
export const client = (id: number, name: string, fields: Record<string, unknown> = {}): GeneralResource => ({
  id,
  name,
  currency: 'USD',
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})
export const project = (id: number, name: string, fields: Record<string, unknown> = {}): GeneralResource => ({
  id,
  name,
  client_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})
export const page = (data: readonly GeneralResource[], next_cursor: string | null = null) => ({
  data,
  page: { next_cursor },
})
export const identity = (profile: Whoami['profile']): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

export const writeDocument = (path: string): void => {
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
export const emptyTimeReport: TimeReport = {
  from: '2026-08-01',
  to: '2026-08-31',
  fixed_fee_included: false,
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

export const emptyProfitTotals = {
  rounded_seconds: 0,
  revenue_cents: 0,
  cost_cents: 0,
  profit_cents: 0,
  return_on_cost_ppm: null,
  revenue_fee_cents: 0,
  fees_included_in_delivery_cost_cents: 0,
  entries_without_billable_rate: 0,
  claimed: false,
  entries_without_cost_rate: 0,
  projects_not_converted: 0,
}

export const emptyProfitFilters = {
  project_status: 'all',
  billing_method: null,
  manager_id: null,
  tag_id: null,
} as const

export const baseApi = (overrides: Partial<ReportWorkspaceApi> = {}): Partial<ReportWorkspaceApi> => ({
  listReportClients: vi.fn(async () => page([client(1, 'Parent'), client(2, 'Studio', { parent_client_id: 1, currency: 'EUR' })])),
  listReportProjects: vi.fn(async () => page([project(7, 'Launch', { code: 'WEB', client_id: 2 })])),
  getUninvoicedReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    client_id: null,
    project_id: null,
    totals: [],
    projects: [],
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
  getInvoicedReport: vi.fn(async () => ({
    from: '2026-08-01', to: '2026-08-31', client_id: null, status: null,
    totals: [], rows: [],
  })),
  getPaymentsReceivedReport: vi.fn(async () => ({
    from: '2026-08-01', to: '2026-08-31', client_id: null, totals: [], rows: [],
  })),
  getReceivablesReport: vi.fn(async () => ({
    as_of: '2026-08-31', client_id: null, totals: [], rows: [],
  })),
  getActivityLog: vi.fn(async () => []),
  getDetailedExpenseReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    client_id: null,
    project_id: null,
    category_id: null,
    user_id: null,
    billable: null,
    reimbursable: null,
    invoice_state: 'all' as const,
    active_projects_only: false,
    totals: [],
    rows: [],
  })),
  getProfitabilityReport: vi.fn(async () => ({
    from: '2026-08-01',
    to: '2026-08-31',
    organization_currency: 'USD',
    rows: [],
    clients: [], teammates: [], tasks: [], trend: [],
    filters: emptyProfitFilters,
    totals: emptyProfitTotals,
    previous_from: '2026-07-01',
    previous_to: '2026-07-31',
    previous_totals: emptyProfitTotals,
  })),
  ...overrides,
})

export const detailedTimeRow = (fields: Partial<DetailedTimeRow> = {}): DetailedTimeRow => ({
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
  claimed: false,
  ...fields,
})

export const detailedTimeReport = (
  fields: Partial<DetailedTimeReport> = {},
): DetailedTimeReport => ({
  from: '2026-08-01',
  to: '2026-08-31',
  client_id: null,
  project_id: null,
  task_id: null,
  user_id: null,
  role_id: null,
  tag_id: null,
  invoice_state: 'all',
  hours: 'all',
  grain: 'day',
  active_projects_only: false,
  seconds: 0,
  rounded_seconds: 0,
  billable_seconds: 0,
  uninvoiced_billable_seconds: 0,
  claimed_seconds: 0,
  unclaimed_seconds: 0,
  time_entry_count: 0,
  currencies: [],
  facets: { people: [], tasks: [], roles: [], tags: [] },
  rows: [],
  ...fields,
})
