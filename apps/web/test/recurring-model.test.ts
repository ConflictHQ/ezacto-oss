import { describe, expect, it } from 'vitest'
import type { GeneralResource, RecurringInvoice } from '@ezacto/client'
import {
  recurringAmountLabel,
  recurringBasisLabel,
  recurringCadenceLabel,
  recurringClientLabel,
  recurringCurrency,
  recurringDayLabel,
  recurringDueLabel,
  recurringDueState,
  recurringFixedTotalCents,
  recurringGenerationOutcome,
  recurringIssuedMessage,
  recurringListOrder,
  recurringMatchesSearch,
  recurringSelectionFromUrl,
  recurringWorkspaceUrl,
} from '../src/recurring/model.js'

const timestamp = '2026-09-09T12:00:00.000Z'

const definition = (overrides: Partial<RecurringInvoice> = {}): RecurringInvoice => ({
  id: 1,
  client_id: 4,
  subject_template: 'Managed services',
  notes_template: 'Thank you.',
  every_n_months: 1,
  day_of_month: 1,
  next_issue_on: '2026-10-01',
  amount_config: {
    schema_version: 1,
    type: 'fixed_lines',
    line_items: [
      {
        kind: 'Service',
        description: 'Retainer',
        quantity: 1,
        unit_price_cents: 1_620_000,
        taxed: false,
        taxed2: false,
        project_id: null,
      },
      {
        kind: 'Service',
        description: 'Support',
        quantity: 2,
        unit_price_cents: 450_000,
        taxed: false,
        taxed2: false,
        project_id: null,
      },
    ],
  },
  can_draw_from_retainer_id: null,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const sweep = (overrides: Partial<RecurringInvoice> = {}): RecurringInvoice =>
  definition({
    id: 2,
    amount_config: {
      schema_version: 1,
      type: 'line_items_import',
      project_ids: [7, 9],
      time: { summary_type: 'project' },
      expenses: { summary_type: 'category' },
    },
    ...overrides,
  })

const clients: readonly GeneralResource[] = [
  { id: 4, name: 'Northpeak', currency: 'EUR', created_at: timestamp, updated_at: timestamp },
]

describe('recurring invoice model', () => {
  it('[unit] names the cadence the way someone would say it aloud', () => {
    // A cadence is read to check it is the one that was meant, so "Every month
    // on the 1st" has to survive being read out. "every_n_months: 1" does not.
    expect(recurringCadenceLabel(definition())).toBe('Every month on the 1st')
    expect(recurringCadenceLabel(definition({ every_n_months: 3, day_of_month: 15 }))).toBe(
      'Every quarter on the 15th',
    )
    expect(recurringCadenceLabel(definition({ every_n_months: 12, day_of_month: 2 }))).toBe(
      'Every year on the 2nd',
    )
    expect(recurringCadenceLabel(definition({ every_n_months: 4, day_of_month: 23 }))).toBe(
      'Every 4 months on the 23rd',
    )
  })

  it('[unit] gets the ordinals right where English stops being regular', () => {
    // 11, 12 and 13 are the whole reason this is a function and not a suffix
    // table indexed by the last digit.
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(recurringDayLabel)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st',
    ])
  })

  it('[unit] separates past due from due today from scheduled', () => {
    const today = '2026-10-01T09:00:00.000Z'
    expect(recurringDueState(definition({ next_issue_on: '2026-09-01' }), today)).toBe('overdue')
    expect(recurringDueState(definition({ next_issue_on: '2026-10-01' }), today)).toBe('due')
    expect(recurringDueState(definition({ next_issue_on: '2026-11-01' }), today)).toBe(
      'scheduled',
    )
    // Past due reads as work waiting, not as a fault. It is the row the screen
    // exists to let someone act on.
    expect(recurringDueLabel('overdue')).toBe('Past due')
  })

  it('[unit] totals fixed lines, and refuses to invent a total for a sweep', () => {
    // 1 x 1,620,000 + 2 x 450,000. A line_items_import definition bills whatever
    // is uninvoiced when the day comes, so any number here would be a guess
    // wearing a currency symbol.
    expect(recurringFixedTotalCents(definition())).toBe(2_520_000)
    expect(recurringFixedTotalCents(sweep())).toBeNull()
    expect(recurringAmountLabel(definition(), 'EUR')).toBe('€25,200.00')
    expect(recurringAmountLabel(sweep(), 'EUR')).toBe('Set when it runs')
  })

  it('[unit] says what a definition will bill for in one line', () => {
    expect(recurringBasisLabel(definition())).toBe('2 fixed lines')
    expect(
      recurringBasisLabel(
        definition({
          amount_config: {
            schema_version: 1,
            type: 'fixed_lines',
            line_items: [
              {
                kind: 'Service',
                description: null,
                quantity: 1,
                unit_price_cents: 100,
                taxed: false,
                taxed2: false,
                project_id: null,
              },
            ],
          },
        }),
      ),
    ).toBe('1 fixed line')
    expect(recurringBasisLabel(sweep())).toBe(
      'Uninvoiced time by project and expenses by category on 2 projects',
    )
    expect(
      recurringBasisLabel(
        sweep({
          amount_config: {
            schema_version: 1,
            type: 'line_items_import',
            project_ids: [7],
            time: { summary_type: 'detailed' },
          },
        }),
      ),
    ).toBe('Uninvoiced time in detail on 1 project')
  })

  it('[unit] reads its currency from the client, because a definition has none', () => {
    expect(recurringCurrency(definition(), clients)).toBe('EUR')
    expect(recurringCurrency(definition({ client_id: 99 }), clients)).toBe('USD')
    expect(recurringClientLabel(definition(), clients)).toBe('Northpeak')
    expect(recurringClientLabel(definition({ client_id: 99 }), clients)).toBe('Client #99')
  })

  it('[unit] keeps the four answers to "issue it" apart', () => {
    // Not-due and already-generated are both 409 and both mean the definition
    // is working as instructed. Reading either as a failure is what sends
    // someone off to fix a definition that was never wrong.
    const refusal = (status: number, code: string, message: string) =>
      Object.assign(new Error(message), {
        status,
        body: { error: { code, message } },
      })

    expect(
      recurringGenerationOutcome(
        refusal(409, 'not_due', 'definition 3 is not due until 2026-10-01'),
      ),
    ).toEqual({ kind: 'not_due', message: 'definition 3 is not due until 2026-10-01' })
    expect(
      recurringGenerationOutcome(
        refusal(409, 'already_generated', 'this period was already generated'),
      ).kind,
    ).toBe('already_generated')
    // 503 is the deployment having no engine. A 404 would have read as "no such
    // definition" and sent an operator looking for the wrong problem.
    expect(recurringGenerationOutcome(refusal(503, 'internal_error', 'The API data service is temporarily unavailable.'))).toEqual({
      kind: 'unavailable',
      message: 'This deployment cannot issue recurring invoices. Nothing has changed.',
    })
    expect(recurringGenerationOutcome(refusal(404, 'not_found', 'gone')).kind).toBe('error')
  })

  it('[unit] says where the cadence landed next, which is the actionable part', () => {
    expect(
      recurringIssuedMessage({ period: '2026-09', next_issue_on: '2026-10-01' }),
    ).toBe('Issued for 2026-09. Next on 2026-10-01.')
  })

  it('[unit] orders by what is owed soonest, not by id', () => {
    const rows = recurringListOrder([
      definition({ id: 3, next_issue_on: '2026-12-01' }),
      definition({ id: 1, next_issue_on: '2026-09-01' }),
      definition({ id: 2, next_issue_on: '2026-09-01' }),
    ])
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3])
  })

  it('[unit] searches the subject, the client name and the id', () => {
    expect(recurringMatchesSearch(definition(), clients, '')).toBe(true)
    expect(recurringMatchesSearch(definition(), clients, 'northpeak')).toBe(true)
    expect(recurringMatchesSearch(definition(), clients, 'managed')).toBe(true)
    expect(recurringMatchesSearch(definition(), clients, 'alva')).toBe(false)
  })

  it('[unit] round-trips the open definition through the URL', () => {
    expect(recurringWorkspaceUrl()).toBe('/invoices/recurring')
    expect(recurringWorkspaceUrl(7)).toBe('/invoices/recurring?definition=7')
    expect(
      recurringSelectionFromUrl(new URL('https://x.test/invoices/recurring?definition=7')),
    ).toBe(7)
    // Anything unparseable opens the list rather than a detail for NaN.
    for (const raw of ['0', '-1', 'abc', '1.5', '']) {
      expect(
        recurringSelectionFromUrl(new URL(`https://x.test/invoices/recurring?definition=${raw}`)),
      ).toBeNull()
    }
  })
})
