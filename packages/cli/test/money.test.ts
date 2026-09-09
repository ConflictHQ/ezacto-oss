import { describe, expect, it } from 'vitest'
import {
  confidentialityFilteredFetch,
  expenseExportColumns,
  timeExportColumns,
  validExportColumns,
  validReportDefinitions,
  withoutConfidentialFields,
} from '../src/money.js'

describe('CLI money module', () => {
  it('[unit] exposes the canonical report definitions', () => {
    const definitions = validReportDefinitions()
    expect(definitions).toContain('uninvoiced')
    expect(definitions).toContain('client-rollup')
    expect(definitions).toContain('project-budget')
    expect(definitions.length).toBe(3)
  })

  it('[unit] exportable columns describe the work without exposing invoice state', () => {
    expect(validExportColumns('time')).toEqual([
      'id', 'user_id', 'project_id', 'task_id', 'spent_date',
      'seconds', 'billable', 'notes',
    ])
    expect(validExportColumns('expenses')).toEqual([
      'id', 'user_id', 'project_id', 'expense_category_id', 'spent_date',
      'total_cost_cents', 'billable', 'notes',
    ])
  })

  it('[unit] every enumerated rate column is marked confidential', () => {
    // The enumeration has to know about the rates to be able to withhold them,
    // so the invariant is not "no rate column exists" but "no rate column is
    // exportable". A new one added without the flag fails here.
    const rateColumns = [...timeExportColumns, ...expenseExportColumns].filter(
      (column) => column.name.includes('rate'),
    )
    expect(rateColumns.map((column) => column.name)).toEqual([
      'billable_rate_cents',
      'cost_rate_cents',
    ])
    for (const column of rateColumns) {
      expect(column.confidential, `${column.name} must be confidential`).toBe(true)
    }
  })

  it('[unit] the filter reaches every depth and keeps the rest of the record', () => {
    const filtered = withoutConfidentialFields({
      root_client_id: 1,
      nodes: [
        {
          client_id: 1,
          budget_burn_cents: 14600,
          rollup: {
            rounded_seconds: 7200,
            currencies: [{ currency: 'USD', expense_cents: 0, cost_cents: 14600 }],
          },
        },
      ],
      entries: [{ id: 1, seconds: 7200, cost_rate_cents: 7300, billable_rate_cents: 18500 }],
    })
    expect(filtered).toEqual({
      root_client_id: 1,
      nodes: [
        {
          client_id: 1,
          rollup: {
            rounded_seconds: 7200,
            currencies: [{ currency: 'USD', expense_cents: 0 }],
          },
        },
      ],
      entries: [{ id: 1, seconds: 7200 }],
    })
  })

  it('[unit] a spend is confidential on a cost grain and kept on a billable one', () => {
    // The same field name means two different things depending on the grain it
    // sits in: a cost spend is what we pay, a billable spend is what the client
    // is asked to pay, and an export exists to show the second.
    expect(
      withoutConfidentialFields({
        calculation: 'cost',
        budget_cents: 500000,
        spent_cents: 14600,
        remaining_cents: 485400,
      }),
    ).toEqual({ calculation: 'cost', budget_cents: 500000 })
    expect(
      withoutConfidentialFields({
        calculation: 'billable',
        budget_cents: 500000,
        spent_cents: 37000,
        remaining_cents: 463000,
      }),
    ).toEqual({
      calculation: 'billable',
      budget_cents: 500000,
      spent_cents: 37000,
      remaining_cents: 463000,
    })
  })

  it('[unit] the budget summary says it in budget_by, and is read there', () => {
    // The sibling serializer in the same report family — one row per project,
    // GET /api/v1/reports/project-budgets — emits no `calculation` at all. It
    // says the same thing in `budget_by`, where only task_fees is billed at the
    // client's rate. These are the two rows that endpoint really returns.
    expect(
      withoutConfidentialFields({
        project_id: 1,
        currency: 'USD',
        budget_by: 'project_cost',
        unit: 'cents',
        unpriced_entry_count: 0,
        budget_cents: 500000,
        spent_cents: 14600,
        remaining_cents: 485400,
        cost_cents: 14600,
      }),
    ).toEqual({
      project_id: 1,
      currency: 'USD',
      budget_by: 'project_cost',
      unit: 'cents',
      unpriced_entry_count: 0,
      budget_cents: 500000,
    })
    expect(
      withoutConfidentialFields({
        project_id: 2,
        currency: 'USD',
        budget_by: 'task_fees',
        unit: 'cents',
        unpriced_entry_count: 0,
        budget_cents: null,
        spent_cents: 37000,
        remaining_cents: null,
        cost_cents: 14600,
      }),
    ).toEqual({
      project_id: 2,
      currency: 'USD',
      budget_by: 'task_fees',
      unit: 'cents',
      unpriced_entry_count: 0,
      budget_cents: null,
      spent_cents: 37000,
      remaining_cents: null,
    })
  })

  it('[unit] a record naming no cost discriminator withholds the pair', () => {
    // The register is trusted to cover the next payload shape somebody adds, so
    // a shape it does not recognise has to fail closed. An amount that reaches
    // the terminal because its discriminator is absent is the whole hole.
    expect(
      withoutConfidentialFields({
        budget_cents: 500000,
        spent_cents: 14600,
        remaining_cents: 485400,
      }),
    ).toEqual({ budget_cents: 500000 })
  })

  it('[unit] the filtered fetch rewrites JSON bodies and leaves everything else alone', async () => {
    const jsonResponse = await confidentialityFilteredFetch(
      async () =>
        new Response(JSON.stringify({ data: { id: 1, cost_rate_cents: 7300 } }), {
          headers: { 'content-type': 'application/json; charset=UTF-8' },
        }),
    )('https://example.invalid/api/v1/time-entries/1')
    expect(await jsonResponse.json()).toEqual({ data: { id: 1 } })

    // A CSV or PDF body is not ours to reinterpret, so it passes through byte
    // for byte rather than being parsed and rebuilt.
    const textResponse = await confidentialityFilteredFetch(
      async () =>
        new Response('cost_rate_cents\n7300\n', {
          headers: { 'content-type': 'text/csv' },
        }),
    )('https://example.invalid/anything')
    expect(await textResponse.text()).toBe('cost_rate_cents\n7300\n')
  })
})
