import { describe, expect, it } from 'vitest'
import type { GeneralResource, RecurringInvoice, Whoami } from '@conflict-hq/ezacto-client'
import {
  recurringAmountLabel,
  recurringBasisLabel,
  recurringBlankFormValues,
  recurringBlankLine,
  recurringCadenceLabel,
  recurringClientLabel,
  recurringCurrency,
  recurringDayLabel,
  recurringDefinitionInput,
  recurringDueLabel,
  recurringDueState,
  recurringFixedTotalCents,
  recurringFormValuesFromDefinition,
  recurringGenerationOutcome,
  recurringIdentityCanWrite,
  recurringIssuedMessage,
  recurringListOrder,
  recurringMatchesSearch,
  recurringSelectionFromUrl,
  recurringWorkspaceUrl,
  type RecurringDefinitionFormValues,
  type RecurringLineFormValues,
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
  claims_project_ids: null,
  claim_mode: 'all',
  claim_ceiling_seconds: null,
  claim_ceiling_cents: null,
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

const line = (
  overrides: Partial<RecurringLineFormValues> = {},
): RecurringLineFormValues => ({
  ...recurringBlankLine(),
  kind: 'Service',
  description: 'Retainer',
  quantity: '1',
  unitPriceCents: '1620000',
  ...overrides,
})

const form = (
  overrides: Partial<RecurringDefinitionFormValues> = {},
): RecurringDefinitionFormValues => ({
  ...recurringBlankFormValues(),
  clientId: '4',
  subjectTemplate: 'Managed services',
  notesTemplate: 'Thank you.',
  everyNMonths: '1',
  dayOfMonth: '1',
  nextIssueOn: '2026-10-01',
  lines: [line()],
  ...overrides,
})

const identity = (profile: Whoami['profile']): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

describe('recurring definition editor input', () => {
  it('[unit] emits exactly the keys the strict validator allows, and no more', () => {
    // `assertRecurringAmountConfig` compares the key set, not just the values:
    // a config with one key it does not recognise is refused whole, and so is a
    // config missing one. So the assertion is on the key set itself.
    const input = recurringDefinitionInput(form())
    expect(input.amount_config.type).toBe('fixed_lines')
    const config = input.amount_config as { line_items: Record<string, unknown>[] }
    expect(config.line_items).toHaveLength(1)
    expect(Object.keys(config.line_items[0]!).sort()).toEqual([
      'description',
      'kind',
      'project_id',
      'quantity',
      'taxed',
      'taxed2',
      'unit_price_cents',
    ])
    expect(input).toEqual({
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
        ],
      },
      can_draw_from_retainer_id: null,
      claims_project_ids: null,
      claim_mode: 'all',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: null,
    })
  })

  it('[unit] carries a through date and an installment total onto the line', () => {
    const input = recurringDefinitionInput(
      form({
        lines: [
          line({
            kind: 'Credit',
            description: 'CREDIT %line_installment_number% of %line_installment_total%',
            unitPriceCents: '-45000',
            through: '2026-12-01',
            installments: '4',
            projectId: '7',
            taxed: true,
          }),
        ],
      }),
    )
    const config = input.amount_config as { line_items: Record<string, unknown>[] }
    expect(config.line_items).toHaveLength(1)
    expect(config.line_items[0]).toEqual({
      kind: 'Credit',
      description: 'CREDIT %line_installment_number% of %line_installment_total%',
      quantity: 1,
      // Signed, because the lines that count themselves off are the discounts
      // and credits, and those are negative unit prices.
      unit_price_cents: -45_000,
      taxed: true,
      taxed2: false,
      project_id: 7,
      through: '2026-12-01',
      installments: 4,
    })
  })

  it('[unit] refuses an installment total with nothing to count back from', () => {
    // The same rule the 0044 trigger enforces. Said here so the sentence names
    // the line: a trigger abort reaches the browser as "amount config is
    // invalid" and nothing more.
    expect(() =>
      recurringDefinitionInput(form({ lines: [line(), line({ installments: '4' })] })),
    ).toThrow('Line 2 needs a through date before it can count installments.')
  })

  it('[unit] refuses a through date the calendar does not have', () => {
    // 2026-02-31 is the right shape and not a day. A line that expires on a day
    // that never comes never expires.
    expect(() =>
      recurringDefinitionInput(form({ lines: [line({ through: '2026-02-31' })] })),
    ).toThrow('Line 1 has a through date that is not a day on the calendar.')
    expect(() =>
      recurringDefinitionInput(form({ nextIssueOn: '2026-02-31' })),
    ).toThrow('Next issue date must be a day on the calendar.')
  })

  it('[unit] refuses the definition-level values the API parser bounds', () => {
    expect(() => recurringDefinitionInput(form({ subjectTemplate: '   ' }))).toThrow(
      'Enter a subject',
    )
    expect(() => recurringDefinitionInput(form({ dayOfMonth: '32' }))).toThrow(
      'Day of month must be from 1 through 31.',
    )
    expect(() => recurringDefinitionInput(form({ everyNMonths: '0' }))).toThrow(
      'Months between issues must be 1 or more.',
    )
    expect(() => recurringDefinitionInput(form({ clientId: '' }))).toThrow(
      'Client must be a whole number.',
    )
    expect(() => recurringDefinitionInput(form({ lines: [] }))).toThrow(
      'A fixed definition needs at least one line.',
    )
    expect(() =>
      recurringDefinitionInput(form({ lines: [line({ quantity: '0' })] })),
    ).toThrow('Line 1 needs a quantity greater than zero.')
    expect(() =>
      recurringDefinitionInput(form({ lines: [line({ unitPriceCents: '12.50' })] })),
    ).toThrow('Line 1 unit price must be a whole number of cents.')
  })

  it('[unit] builds each sweep variant the contract has a shape for', () => {
    const sweepForm = (overrides: Partial<RecurringDefinitionFormValues>) =>
      recurringDefinitionInput(
        form({ amountType: 'line_items_import', projectIds: ['7', '9'], ...overrides }),
      ).amount_config
    expect(sweepForm({ importTime: true, importExpenses: false })).toEqual({
      schema_version: 1,
      type: 'line_items_import',
      project_ids: [7, 9],
      time: { summary_type: 'project' },
    })
    expect(
      sweepForm({ importTime: false, importExpenses: true, expenseSummary: 'detailed' }),
    ).toEqual({
      schema_version: 1,
      type: 'line_items_import',
      project_ids: [7, 9],
      expenses: { summary_type: 'detailed' },
    })
    expect(
      sweepForm({ importTime: true, timeSummary: 'task', importExpenses: true }),
    ).toEqual({
      schema_version: 1,
      type: 'line_items_import',
      project_ids: [7, 9],
      time: { summary_type: 'task' },
      expenses: { summary_type: 'category' },
    })
  })

  it('[unit] refuses a sweep that would sweep nothing, or the same project twice', () => {
    const sweep = (overrides: Partial<RecurringDefinitionFormValues>) => () =>
      recurringDefinitionInput(
        form({ amountType: 'line_items_import', projectIds: ['7'], ...overrides }),
      )
    expect(sweep({ importTime: false, importExpenses: false })).toThrow(
      'A sweep must bill uninvoiced time, uninvoiced expenses, or both.',
    )
    expect(sweep({ projectIds: [] })).toThrow('Choose at least one project to sweep.')
    expect(sweep({ projectIds: ['7', '7'] })).toThrow('A project can only be swept once.')
  })

  it('[unit] round-trips a stored definition through the form unchanged', () => {
    // PATCH replaces the whole definition, so an edit that touches only the day
    // of month still sends the amount config back. If the form loses a key on
    // the way in, the save silently rewrites what it was not asked to change --
    // which is how a line's through date disappears on a date correction.
    const stored = definition({
      can_draw_from_retainer_id: 3,
      amount_config: {
        schema_version: 1,
        type: 'fixed_lines',
        line_items: [
          {
            kind: 'Service',
            description: 'Retainer',
            quantity: 1.5,
            unit_price_cents: 1_620_000,
            taxed: true,
            taxed2: false,
            project_id: 7,
          },
          {
            kind: 'Credit',
            description: 'CREDIT %line_installment_number% of %line_installment_total%',
            quantity: 1,
            unit_price_cents: -45_000,
            taxed: false,
            taxed2: false,
            project_id: null,
            through: '2026-12-01',
            installments: 4,
          },
        ],
      },
    })
    const values = recurringFormValuesFromDefinition(stored)
    expect(values.lines).toHaveLength(2)
    // The first line has neither key, and reads back as two empty boxes rather
    // than as the string "null".
    expect(values.lines[0]!.through).toBe('')
    expect(values.lines[0]!.installments).toBe('')
    expect(values.lines[1]!.through).toBe('2026-12-01')
    expect(values.lines[1]!.installments).toBe('4')
    const input = recurringDefinitionInput({ ...values, dayOfMonth: '15' })
    expect(input.amount_config).toEqual(stored.amount_config)
    expect(input.day_of_month).toBe(15)
    expect(input.client_id).toBe(stored.client_id)
    expect(input.notes_template).toBe(stored.notes_template)
    expect(input.can_draw_from_retainer_id).toBe(3)
  })

  it('[unit] round-trips a sweep without turning it into an empty fixed definition', () => {
    const stored = sweep()
    const values = recurringFormValuesFromDefinition(stored)
    expect(values.amountType).toBe('line_items_import')
    expect(values.projectIds).toEqual(['7', '9'])
    expect(recurringDefinitionInput(values).amount_config).toEqual(stored.amount_config)
  })

  it('[unit] lets exactly the profiles that may write invoices write definitions', () => {
    // A standing instruction that raises invoices is an invoice-writing power.
    expect(recurringIdentityCanWrite(identity('administrator'))).toBe(true)
    expect(recurringIdentityCanWrite(identity('accounting'))).toBe(true)
    expect(recurringIdentityCanWrite(identity('executive_manager'))).toBe(true)
    expect(recurringIdentityCanWrite(identity('member'))).toBe(false)
    expect(recurringIdentityCanWrite(identity('project_manager'))).toBe(false)
    expect(recurringIdentityCanWrite(identity('people_admin'))).toBe(false)
    // A token has to carry the scope; a session already does.
    expect(
      recurringIdentityCanWrite({
        ...identity('accounting'),
        authentication: { kind: 'token', token_id: 1, scopes: ['invoices:read'] },
      }),
    ).toBe(false)
    expect(
      recurringIdentityCanWrite({
        ...identity('accounting'),
        authentication: { kind: 'token', token_id: 1, scopes: ['invoices:write'] },
      }),
    ).toBe(true)
  })
})

/**
 * Issue 484. A banded engagement bills a flat amount and claims the period's
 * hours rather than pricing them. The model has held that since 0060 and no
 * screen could set it, so the arrangement could only be configured with a SQL
 * statement.
 */
describe('a banded engagement, from the form (#484)', () => {
  it('[money] sends the projects a flat amount covers', () => {
    const values = {
      ...recurringBlankFormValues(),
      clientId: '1',
      subjectTemplate: 'Banded team',
      nextIssueOn: '2026-10-10',
      lines: [
        { kind: 'Service', description: 'Band', quantity: '1', unitPriceCents: '9368500',
          taxed: false, taxed2: false, projectId: '', through: '', installments: '' },
      ],
      claimsProjectIds: ['7', '9'],
    }
    expect(recurringDefinitionInput(values as never)).toMatchObject({
      claims_project_ids: [7, 9],
    })
  })

  it('[money] sends null for an ordinary fixed invoice, never an empty list', () => {
    // Empty and null would be two spellings of "not banded", and the API
    // refuses the empty one rather than accepting a third state.
    const values = {
      ...recurringBlankFormValues(),
      clientId: '1',
      subjectTemplate: 'Monthly',
      nextIssueOn: '2026-10-10',
      lines: [
        { kind: 'Service', description: 'Retainer', quantity: '1', unitPriceCents: '10000',
          taxed: false, taxed2: false, projectId: '', through: '', installments: '' },
      ],
    }
    expect(recurringDefinitionInput(values as never).claims_project_ids).toBeNull()
  })

  it('[money] reads a stored band back, so editing another field cannot un-band it', () => {
    // PATCH replaces the whole definition. An editor that dropped this would
    // silently turn a banded engagement into one that bills the time as well,
    // the next time somebody corrected its day of month.
    const values = recurringFormValuesFromDefinition(
      definition({ claims_project_ids: [7, 9] }),
    )
    expect(values.claimsProjectIds).toEqual(['7', '9'])
    expect(recurringFormValuesFromDefinition(definition()).claimsProjectIds).toEqual([])
  })

  const banded = (extra: Record<string, unknown>) => ({
    ...recurringBlankFormValues(),
    clientId: '1',
    subjectTemplate: 'Banded team',
    nextIssueOn: '2026-10-10',
    lines: [
      { kind: 'Service', description: 'Band', quantity: '1', unitPriceCents: '9368500',
        taxed: false, taxed2: false, projectId: '', through: '', installments: '' },
    ],
    claimsProjectIds: ['7'],
    ...extra,
  })

  it('[money] sends a ceiling in the unit the operator chose, and only that unit', () => {
    // A capacity promise and a budget are different deals. Sending both numbers
    // would be two answers to one question, and the API refuses it.
    expect(
      recurringDefinitionInput(
        banded({ claimMode: 'ceiling', claimCeilingUnit: 'time', claimCeiling: '400h' }) as never,
      ),
    ).toMatchObject({
      claim_mode: 'ceiling',
      claim_ceiling_seconds: 1_440_000,
      claim_ceiling_cents: null,
    })
    expect(
      recurringDefinitionInput(
        banded({
          claimMode: 'ceiling',
          claimCeilingUnit: 'money',
          claimCeiling: '9368500',
        }) as never,
      ),
    ).toMatchObject({
      claim_mode: 'ceiling',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: 9_368_500,
    })
  })

  it('[money] drops a ceiling left behind on a definition that claims nothing', () => {
    // Switching a band back to an ordinary fixed invoice leaves whatever was
    // typed in the ceiling box. Sending it would be refused, and storing it
    // would be a number somebody later assumes applied.
    expect(
      recurringDefinitionInput(
        banded({
          claimsProjectIds: [],
          claimMode: 'ceiling',
          claimCeilingUnit: 'money',
          claimCeiling: '9368500',
        }) as never,
      ),
    ).toMatchObject({
      claim_mode: 'all',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: null,
    })
  })

  it('[money] reads a stored ceiling back in the unit it was stored in', () => {
    // Same reason as the band itself: PATCH replaces the definition, so an
    // editor that dropped the ceiling would quietly widen the band to every
    // hour the next time somebody corrected an unrelated field.
    const hours = recurringFormValuesFromDefinition(
      definition({ claims_project_ids: [7], claim_mode: 'ceiling', claim_ceiling_seconds: 1_440_000 }),
    )
    expect(hours).toMatchObject({
      claimMode: 'ceiling',
      claimCeilingUnit: 'time',
      claimCeiling: '400h',
    })
    const money = recurringFormValuesFromDefinition(
      definition({ claims_project_ids: [7], claim_mode: 'ceiling', claim_ceiling_cents: 9_368_500 }),
    )
    expect(money).toMatchObject({
      claimMode: 'ceiling',
      claimCeilingUnit: 'money',
      claimCeiling: '9368500',
    })
  })

  it('[unit] renders a ceiling that is not whole hours as something it can read back', () => {
    // A value written by some other caller must survive being opened in this
    // form and saved again, rather than being rounded to the nearest hour.
    const values = recurringFormValuesFromDefinition(
      definition({ claims_project_ids: [7], claim_mode: 'ceiling', claim_ceiling_seconds: 5_430 }),
    )
    expect(values.claimCeiling).toBe('1h30.5m')
    expect(
      recurringDefinitionInput(
        banded({
          claimMode: 'ceiling',
          claimCeilingUnit: 'time',
          claimCeiling: values.claimCeiling,
        }) as never,
      ).claim_ceiling_seconds,
    ).toBe(5_430)
  })
})
