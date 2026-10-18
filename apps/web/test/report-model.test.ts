import type { ContractorCostReport, DetailedTimeRow, EzactoClient, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import {
  billablePercent,
  canReadCostReports,
  canReadFinancialReports,
  contractorCostCsv,
  createShellApi,
  detailedExpenseCsv,
  detailedTimeExportPath,
  detailedTimeOptionsFromUrl,
  formatReportCents,
  formatReportHours,
  formatReportMoney,
  groupDetailedTimeRows,
  reportFiltersFromUrl,
  reportFiltersUrl,
  timeReportOptionsFromUrl,
  validateReportFilters,
} from '../src/index.js'

const detailedRow = (fields: Partial<DetailedTimeRow> = {}): DetailedTimeRow => ({
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

const secondPerson: Partial<DetailedTimeRow> = {
  user_id: 2,
  user_name: 'Grace Hopper',
  seconds: 1_800,
}
const nextDay: Partial<DetailedTimeRow> = { spent_date: '2026-08-11', seconds: 900 }

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
      // Carried on every kind's filters and written to none but the Time
      // report's address, which is the only report that has sub-tabs.
      tab: 'clients',
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
        tab: 'teammates',
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

  it('[unit #720] carries the fixed-fee decision only on the Time report URL', () => {
    const location = new URL(
      'https://example.test/reports?report=time&include_fixed_fee=true',
    )
    const filters = reportFiltersFromUrl(location, '2026-09-10')
    const options = timeReportOptionsFromUrl(location)
    expect(options).toEqual({ includeFixedFee: true })
    expect(reportFiltersUrl(filters, undefined, options)).toContain('include_fixed_fee=true')
    expect(reportFiltersUrl({ ...filters, kind: 'uninvoiced' }, undefined, options))
      .not.toContain('include_fixed_fee')
  })

  it('[unit] rejects impossible, inverted, and incomplete report ranges', () => {
    expect(
      validateReportFilters({
        kind: 'uninvoiced',
        from: '2026-02-30',
        to: '2026-03-01',
        clientId: null,
        projectId: null,
        tab: 'clients',
      }),
    ).toContain('valid')
    expect(
      validateReportFilters({
        kind: 'client-rollup',
        from: '2026-09-02',
        to: '2026-09-01',
        clientId: 1,
        projectId: null,
        tab: 'clients',
      }),
    ).toContain('on or after')
    expect(
      validateReportFilters({
        kind: 'project-budget',
        from: '2026-09-01',
        to: '2026-09-01',
        clientId: null,
        projectId: null,
        tab: 'clients',
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

  it('[security] holds cost reports to the administrator alone, grant or no grant', () => {
    const all: Whoami['profile'][] = [
      'member',
      'project_manager',
      'people_admin',
      'accounting',
      'executive_manager',
      'administrator',
    ]
    expect(
      all.filter((profile) => canReadCostReports({ profile, manager_grants: [] })),
    ).toEqual(['administrator'])
    // A narrower set than the financial one, and the two must not drift into
    // each other: accounting reads uninvoiced work and is still refused cost.
    expect(canReadFinancialReports('accounting')).toBe(true)
    expect(canReadCostReports({ profile: 'accounting', manager_grants: [] })).toBe(false)
    // The grant that opens billable rates to a project manager does not open
    // cost rates -- canViewMoneyField only consults it for billable_rate.
    expect(
      canReadCostReports({
        profile: 'project_manager',
        manager_grants: ['billable_rates_manager'],
      }),
    ).toBe(false)
  })

  it('[unit] carries no client or project in a contractor cost address', () => {
    const filters = reportFiltersFromUrl(
      new URL(
        'https://example.test/reports?report=contractor-cost&from=2026-08-01&to=2026-08-31&client_id=3&project_id=9',
      ),
      '2026-09-01',
    )
    expect(filters.kind).toBe('contractor-cost')
    // The endpoint takes a range and nothing else, so a URL that kept the ids
    // would promise a narrowing the report does not do.
    expect(reportFiltersUrl(filters)).toBe(
      '/reports?report=contractor-cost&from=2026-08-01&to=2026-08-31',
    )
    // ...and neither id is required of it, unlike the two kinds that name one.
    expect(validateReportFilters(filters)).toBeNull()
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

  it('[unit] keeps the detailed report Show, Group by and archived choices in the address', () => {
    const filters = reportFiltersFromUrl(
      new URL(
        'https://example.test/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&client_id=3&project_id=9',
      ),
      '2026-09-01',
    )
    const options = detailedTimeOptionsFromUrl(
      new URL(
        'https://example.test/reports?report=detailed-time&hours=uninvoiced&group=person&active_only=true',
      ),
    )
    expect(options).toEqual({
      hours: 'uninvoiced',
      grouping: 'person',
      grain: 'day',
      activeProjectsOnly: true,
      taskId: null,
      userId: null,
      roleId: null,
      tagId: null,
      invoiceState: 'all',
      notes: '',
    })
    expect(reportFiltersUrl(filters, options)).toBe(
      '/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&client_id=3&project_id=9&hours=uninvoiced&group=person&grain=day&active_only=true&invoice_state=all',
    )
    // An unreadable display preference falls back rather than stopping the
    // report: the range is what has to be right, the grouping is a shape.
    expect(
      detailedTimeOptionsFromUrl(
        new URL('https://example.test/reports?hours=everything&group=colour'),
      ),
    ).toEqual({
      hours: 'all',
      grouping: 'date',
      grain: 'day',
      activeProjectsOnly: false,
      taskId: null,
      userId: null,
      roleId: null,
      tagId: null,
      invoiceState: 'all',
    })
    // The other kinds carry none of it: a client rollup has no Show control,
    // and an address implying one would be a control that does not exist.
    expect(
      reportFiltersUrl(
        { ...filters, kind: 'client-rollup', projectId: null },
        {
          hours: 'billable', grouping: 'task', grain: 'day', activeProjectsOnly: true,
          taskId: null, userId: null, roleId: null, tagId: null, invoiceState: 'all',
        },
      ),
    ).toBe('/reports?report=client-rollup&from=2026-08-01&to=2026-08-31&client_id=3')
  })

  it('[unit] regroups the same rows without changing what is in them', () => {
    const rows = [detailedRow(), detailedRow({ ...secondPerson }), detailedRow({ ...nextDay })]
    const byDate = groupDetailedTimeRows(rows, 'date')
    const byPerson = groupDetailedTimeRows(rows, 'person')

    // Counted first: a grouping that produced nothing would otherwise pass
    // every assertion below it by having no band to disagree with.
    expect(byDate).toHaveLength(2)
    expect(byPerson).toHaveLength(2)
    expect(byDate.map((band) => band.label)).toEqual(['2026-08-10', '2026-08-11'])
    expect(byPerson.map((band) => band.label)).toEqual(['Ada Lovelace', 'Grace Hopper'])
    // Same rows, same total, whichever way they are folded.
    const total = (bands: readonly { seconds: number }[]): number =>
      bands.reduce((sum, band) => sum + band.seconds, 0)
    expect(total(byDate)).toBe(total(byPerson))
    expect(total(byDate)).toBe(3_600 + 1_800 + 900)
    expect(byDate.flatMap((band) => band.rows)).toHaveLength(rows.length)
  })

  it('[money] groups by whether an invoice has claimed the hours', () => {
    // #708. "Unclaimed" is not "uninvoiced": on a banded project it could be
    // work the band absorbs next generation, work a ceiling left over that
    // ought to be billed, or work nobody will ever bill. The grouping is what
    // lets somebody look at the three, so the labels say claimed rather than
    // invoiced.
    const rows = [
      detailedRow({ claimed: true }),
      detailedRow({ ...nextDay, claimed: false }),
      detailedRow({ ...secondPerson, claimed: false }),
    ]
    const bands = groupDetailedTimeRows(rows, 'claimed')

    expect(bands).toHaveLength(2)
    expect(bands.map((band) => band.label)).toEqual([
      'Claimed by an invoice',
      'Not claimed yet',
    ])
    expect(bands.map((band) => band.rows.length)).toEqual([1, 2])
    expect(bands.reduce((sum, band) => sum + band.seconds, 0)).toBe(
      rows.reduce((sum, row) => sum + row.seconds, 0),
    )
  })

  it('[unit] reads a claimed grouping and filter out of the address', () => {
    // A saved or shared report address has to come back as the report it was.
    const url = new URL(
      'https://example.test/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&hours=unclaimed&group=claimed',
    )
    expect(detailedTimeOptionsFromUrl(url)).toMatchObject({
      hours: 'unclaimed',
      grouping: 'claimed',
    })
  })

  it('[unit] asks the export for the report on screen, every filter of it, and the file', () => {
    // The file is the server's, so the one thing this side owns is the
    // question: the request that drew the table, serialized as the generated
    // client serializes the report's own query, then the file and whose notes.
    const path = detailedTimeExportPath(
      {
        from: '2026-09-01',
        to: '2026-09-30',
        client_id: 5,
        include_fixed_fee: false,
        direct_client_only: true,
        hours: 'all',
        grain: 'entry',
        invoice_state: 'all',
        active_projects_only: false,
      },
      'pdf',
      'client',
    )
    const url = new URL(path, 'https://example.test')
    expect(url.pathname).toBe('/api/v1/reports/detailed-time/export')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      client_id: '5',
      include_fixed_fee: 'false',
      direct_client_only: 'true',
      hours: 'all',
      grain: 'entry',
      invoice_state: 'all',
      active_projects_only: 'false',
      format: 'pdf',
      audience: 'client',
    })
  })

  it('[security] names the notes it wants in every export, and sends no filter the report lacked', () => {
    const query = (audience: 'client' | 'internal'): URLSearchParams =>
      new URL(
        detailedTimeExportPath({ from: '2026-09-01', to: '2026-09-30', self: true }, 'csv', audience),
        'https://example.test',
      ).searchParams
    // Stated either way, so the server's own default is never what decides
    // whether an internal note leaves the building.
    expect(query('client').get('audience')).toBe('client')
    expect(query('internal').get('audience')).toBe('internal')
    expect([...query('client').keys()]).toEqual(['from', 'to', 'self', 'format', 'audience'])
  })

  it('[unit #723] exports the exact contractor payout fields and disarms formulas', () => {
    const report: ContractorCostReport = {
      from: '2026-08-01',
      to: '2026-08-31',
      rows: [
        {
          user_id: 11,
          name: '=Ada Wren',
          payroll_email: '@ada@example.test',
          is_contractor: true,
          currency: 'USD',
          rounded_seconds: 5_400,
          utilization_ppm: 250_000,
          cost_cents: 18_750,
          cost_rate_cents: 12_500,
          cost_rate_is_mixed: false,
          entry_count: 2,
          entries_without_rate: 0,
        },
      ],
    }

    const csv = contractorCostCsv(report)
    expect(csv.split('\r\n')[0]).toBe(
      '"Type","Person","Payroll email","Hours","Utilization","Rate","Mixed rate","Entries","Unrated entries","Currency","Cost"',
    )
    expect(csv).toContain('"Contractor","\'=Ada Wren","\'@ada@example.test","1.50","25.00"')
    expect(csv).toContain('"125.00","No","2","0","USD","187.50"')
  })

  it('[unit #719] exports full expense notes safely without inventing redacted amounts', () => {
    const csv = detailedExpenseCsv({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: null,
      project_id: null,
      category_id: null,
      user_id: null,
      billable: null,
      reimbursable: null,
      invoice_state: 'all',
      active_projects_only: false,
      totals: [],
      rows: [{
        expense_id: 201,
        spent_date: '2026-08-13',
        client_id: 1,
        client_name: '=Parent',
        project_id: 7,
        project_name: 'Launch',
        project_code: 'WEB',
        category_id: 1,
        category_name: 'Travel',
        user_id: 1,
        user_name: 'Ada Byron',
        notes: '@Taxi from airport\nReceipt is attached in full.',
        units: null,
        billable: true,
        reimbursable: false,
        invoice_id: null,
        currency: 'USD',
      }],
    })

    expect(csv).toContain('"\'=Parent"')
    expect(csv).toContain('"\'@Taxi from airport\nReceipt is attached in full."')
    expect(csv).toContain('"Yes","No","","USD",""')
  })

  it('[unit] maps catalogs and all five reports to generated-client operations', async () => {
    const page = { data: [], links: {}, page: { next_cursor: null } }
    const generated = {
      listClients: vi.fn(async () => page),
      listProjects: vi.fn(async () => page),
      getUninvoicedReport: vi.fn(async () => ({ data: { totals: [] } })),
      getClientRollupReport: vi.fn(async () => ({ data: { nodes: [] } })),
      getProjectBudgetReport: vi.fn(async () => ({ data: { grains: [] } })),
      getMyHoursReport: vi.fn(async () => ({ data: { projects: [] } })),
      getContractorCostReport: vi.fn(async () => ({ data: { rows: [] } })),
      getTimeReport: vi.fn(async () => ({ data: { clients: [] } })),
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
    await api.getContractorCostReport!({ from: '2026-08-01', to: '2026-08-31' }, signal)
    await api.getTimeReport!({ from: '2026-08-01', to: '2026-08-31' }, signal)

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
    expect(generated.getContractorCostReport).toHaveBeenCalledWith({
      query: { from: '2026-08-01', to: '2026-08-31' },
      signal,
    })
    // A range and nothing else: the four groupings all come back in one
    // response, so there is no tab to send.
    expect(generated.getTimeReport).toHaveBeenCalledWith({
      query: { from: '2026-08-01', to: '2026-08-31' },
      signal,
    })
  })

  it('[unit] carries the Time sub-tab in the address and nowhere else', () => {
    const filters = reportFiltersFromUrl(
      new URL(
        'https://example.test/reports?report=time&from=2026-09-01&to=2026-09-30&tab=teammates',
      ),
      '2026-09-30',
    )
    expect(filters).toMatchObject({ kind: 'time', tab: 'teammates' })
    expect(reportFiltersUrl(filters)).toBe(
      '/reports?report=time&from=2026-09-01&to=2026-09-30&tab=teammates',
    )
    // An unreadable tab is a wrong starting tab, not a broken report: the tab
    // chooses a fold of an answer already in hand.
    expect(
      reportFiltersFromUrl(
        new URL('https://example.test/reports?report=time&tab=departments'),
        '2026-09-30',
      ).tab,
    ).toBe('clients')
    // No other kind writes it, because no other kind has sub-tabs.
    expect(
      reportFiltersUrl({
        kind: 'uninvoiced',
        from: '2026-09-01',
        to: '2026-09-30',
        clientId: null,
        projectId: null,
        tab: 'tasks',
      }),
    ).toBe('/reports?report=uninvoiced&from=2026-09-01&to=2026-09-30')
  })

  it('[unit] states no billable share for a row with no hours', () => {
    expect(billablePercent(3600, 7200)).toBe(50)
    expect(billablePercent(0, 7200)).toBe(0)
    // Null, not 0: "0%" of nothing reads as somebody who was busy on nothing
    // billable, which is a different claim from an empty row.
    expect(billablePercent(0, 0)).toBeNull()
  })
})
