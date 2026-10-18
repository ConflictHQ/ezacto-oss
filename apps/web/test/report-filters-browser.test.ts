/** @vitest-environment happy-dom */

import type { DetailedTimeReport, GeneralResource, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createReportsController } from '../src/reports/browser.js'
import type { ReportWorkspaceApi } from '../src/reports/model.js'
import { renderAppShell, reportKindTabs } from '../src/index.js'

/**
 * Issue 930. The report filters as the controller drives them: a change goes
 * back to the API and lands in the address.
 */

const timestamp = '2026-09-01T12:00:00.000Z'
const resource = (id: number, name: string): GeneralResource => ({
  id,
  name,
  currency: 'USD',
  client_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
})
const page = (data: readonly GeneralResource[]) => ({ data, page: { next_cursor: null } })
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
      release: 'report-filters-test',
      activeSection: 'Reports',
      view: 'reports',
      tabs: reportKindTabs(new URL(path, 'https://example.test').searchParams.get('report')),
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const detailed = (fields: Partial<DetailedTimeReport> = {}): DetailedTimeReport => ({
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
  facets: {
    people: [{ id: 2, name: 'Ada Lovelace' }, { id: 3, name: 'Grace Hopper' }],
    tasks: [{ id: 4, name: 'Delivery' }],
    roles: [{ id: 5, name: 'Engineering' }],
    tags: [{ id: 6, name: 'Retainer' }],
  },
  rows: [],
  ...fields,
})

/**
 * The controller refuses to draw unless every report reader is present, so the
 * ones a test does not drive are stubs that are never asked.
 */
const unused = () => vi.fn(async (): Promise<never> => {
  throw new Error('not under test')
})

const api = (overrides: Partial<ReportWorkspaceApi>): Partial<ReportWorkspaceApi> => ({
  listReportClients: vi.fn(async () => page([resource(1, 'Parent')])),
  listReportProjects: vi.fn(async () => page([resource(7, 'Launch')])),
  getUninvoicedReport: unused(),
  getClientRollupReport: unused(),
  getProjectBudgetReport: unused(),
  getMyHoursReport: unused(),
  getContractorCostReport: unused(),
  getDetailedTimeReport: unused(),
  getTimeReport: unused(),
  getActivityLog: unused(),
  getProfitabilityReport: unused(),
  getDetailedExpenseReport: unused(),
  getInvoicedReport: unused(),
  getPaymentsReceivedReport: unused(),
  getReceivablesReport: unused(),
  ...overrides,
})

const activate = async (
  path: string,
  overrides: Partial<ReportWorkspaceApi>,
): Promise<AbortController> => {
  writeDocument(path)
  const session = new AbortController()
  await createReportsController(api(overrides)).activate(identity('accounting'), session.signal, () => false)
  return session
}

const change = (selector: string, value: string): void => {
  const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(selector)!
  control.value = value
  control.dispatchEvent(new Event('change'))
}

describe('Report filters in the browser', () => {
  it('[browser] offers named pickers from the report and asks for the id behind the name', async () => {
    const getDetailedTimeReport = vi.fn(async () => detailed())
    const session = await activate('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31', {
      getDetailedTimeReport,
    })
    const person = document.querySelector<HTMLSelectElement>('#ez-detailed-person')!
    expect([...person.options].map((option) => option.textContent)).toEqual([
      'All people',
      'Ada Lovelace',
      'Grace Hopper',
    ])
    expect(document.querySelector<HTMLSelectElement>('#ez-detailed-task')!.options[1]!.textContent).toBe('Delivery')
    expect(document.querySelector<HTMLSelectElement>('#ez-detailed-role')!.options[1]!.textContent).toBe('Engineering')
    expect(document.querySelector<HTMLSelectElement>('#ez-detailed-tag')!.options[1]!.textContent).toBe('Retainer')

    change('#ez-detailed-person', '3')
    await vi.waitFor(() => expect(getDetailedTimeReport).toHaveBeenCalledTimes(2))
    expect(getDetailedTimeReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ user_id: 3 }),
      expect.anything(),
    )
    expect(window.location.search).toContain('user_id=3')
    session.abort()
  })

  it('[browser] searches notes on the server, keeps the text in the address and lists it as a chip', async () => {
    const getDetailedTimeReport = vi.fn(async () => detailed({ grain: 'entry' }))
    const session = await activate('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&grain=entry', {
      getDetailedTimeReport,
    })
    change('#ez-detailed-notes', 'kickoff')
    await vi.waitFor(() => expect(getDetailedTimeReport).toHaveBeenCalledTimes(2))
    expect(getDetailedTimeReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ notes: 'kickoff' }),
      expect.anything(),
    )
    expect(window.location.search).toContain('notes=kickoff')
    expect(document.querySelector('.filter-bar-chip')?.getAttribute('aria-label')).toBe(
      'Remove filter Notes contain: kickoff',
    )

    document.querySelector<HTMLButtonElement>('.filter-bar-clear')!.click()
    await vi.waitFor(() => expect(getDetailedTimeReport).toHaveBeenCalledTimes(3))
    expect((getDetailedTimeReport.mock.calls as unknown[][])[2]![0]).not.toHaveProperty('notes')
    expect(window.location.search).not.toContain('notes=')
    session.abort()
  })

  it('[browser] reopens a shared address with its filters applied and a missing facet still shown', async () => {
    const getDetailedTimeReport = vi.fn(async () => detailed({ task_id: 99 }))
    const session = await activate(
      '/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&task_id=99&notes=call',
      { getDetailedTimeReport },
    )
    expect(getDetailedTimeReport).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: 99, notes: 'call' }),
      expect.anything(),
    )
    expect(document.querySelector<HTMLSelectElement>('#ez-detailed-task')!.value).toBe('99')
    expect(document.querySelector<HTMLInputElement>('#ez-detailed-notes')!.value).toBe('call')
    session.abort()
  })

  it('[browser] moves the invoiced Status into the table and shows the server totals per currency', async () => {
    const getInvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      status: 'open' as const,
      totals: [
        { currency: 'USD', invoice_count: 2, invoiced_cents: 150_000, paid_cents: 25_000, balance_cents: 125_000 },
        { currency: 'EUR', invoice_count: 1, invoiced_cents: 70_000, paid_cents: 0, balance_cents: 70_000 },
      ],
      rows: [
        {
          invoice_id: 1, number: '1315', state: 'open' as const, close_reason: null,
          issue_date: '2026-08-01', due_date: '2026-08-15', client_id: 1, client_name: 'Parent',
          subject: null, currency: 'USD', invoiced_cents: 100_000, paid_cents: 25_000, balance_cents: 75_000,
        },
      ],
    }))
    const session = await activate('/reports?report=invoiced&from=2026-08-01&to=2026-08-31&status=open', {
      getInvoicedReport,
    })
    const results = document.querySelector('[data-report-results]')!
    expect(results.querySelector('#ez-invoiced-status')).not.toBeNull()
    expect(document.querySelector('form [data-report-invoice-status]')).toBeNull()
    expect(results.querySelector('tfoot')!.textContent).toContain('Total (USD)')
    expect(results.querySelector('tfoot')!.textContent).toContain('$1,250.00')
    expect(results.querySelector('tfoot')!.textContent).toContain('Total (EUR)')

    change('#ez-invoiced-status', 'paid')
    await vi.waitFor(() => expect(getInvoicedReport).toHaveBeenCalledTimes(2))
    expect(getInvoicedReport).toHaveBeenLastCalledWith(
      { from: '2026-08-01', to: '2026-08-31', status: 'paid' },
      expect.anything(),
    )
    expect(window.location.search).toContain('status=paid')
    session.abort()
  })

  it('[browser] filters receivables by due state through the API and totals the footer', async () => {
    const row = {
      currency: 'USD', invoice_count: 1, invoiced_cents: 100_000, outstanding_cents: 75_000,
      not_due_cents: 0, days_1_to_30_cents: 75_000, days_31_to_60_cents: 0, days_61_to_90_cents: 0,
      days_90_plus_cents: 0,
    }
    const getReceivablesReport = vi.fn(async () => ({
      as_of: '2026-08-31',
      client_id: null,
      totals: [row],
      rows: [{ client_id: 1, client_name: 'Parent', ...row }],
    }))
    const session = await activate('/reports?report=receivables&from=2026-08-01&to=2026-08-31', {
      getReceivablesReport,
    })
    const results = document.querySelector('[data-report-results]')!
    expect(results.querySelector('tfoot')!.textContent).toContain('Total (USD)')

    change('#ez-receivables-due-state', 'past_due')
    await vi.waitFor(() => expect(getReceivablesReport).toHaveBeenCalledTimes(2))
    expect(getReceivablesReport).toHaveBeenLastCalledWith(
      { as_of: '2026-08-31', due_state: 'past_due' },
      expect.anything(),
    )
    expect(window.location.search).toContain('due_state=past_due')
    session.abort()
  })

  it('[browser] keeps the filter bar when a filter leaves no rows, so it can be taken off', async () => {
    const getInvoicedReport = vi.fn(async () => ({
      from: '2026-08-01', to: '2026-08-31', client_id: null, status: 'closed' as const, totals: [], rows: [],
    }))
    const session = await activate('/reports?report=invoiced&from=2026-08-01&to=2026-08-31&status=closed', {
      getInvoicedReport,
    })
    const results = document.querySelector('[data-report-results]')!
    expect(results.textContent).toContain('No invoices match these filters.')
    expect(results.querySelector('.filter-bar-clear')).not.toBeNull()
    session.abort()
  })
})
