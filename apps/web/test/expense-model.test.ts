import type { Expense, ExpenseCategory } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  expenseAmountCents,
  expenseApprovalDisplay,
  expenseIdFromPathname,
  expenseIsEditable,
  expensePatch,
  expenseUnits,
  expenseValueInput,
  expenseWeekLabel,
  expenseWeekStart,
  filtersFromSearch,
} from '../src/expenses/model.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const expense = (overrides: Partial<Expense> = {}): Expense => ({
  id: 1,
  user_id: 1,
  project_id: 1,
  expense_category_id: 1,
  spent_date: '2026-09-01',
  notes: 'Receipt note',
  units: null,
  total_cost_cents: 1250,
  billable: true,
  approval_status: 'unsubmitted',
  source_approval_status: null,
  invoice_id: null,
  is_billed: false,
  is_locked: false,
  locked_reason_code: null,
  locked_reason: null,
  reimbursable: true,
  reimbursement_status: 'pending',
  payout_ref: null,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const category = (overrides: Partial<ExpenseCategory> = {}): ExpenseCategory => ({
  id: 1,
  name: 'Travel',
  unit_name: null,
  unit_price_cents: null,
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

describe('expense workflow model', () => {
  it('[unit] parses only numeric expense detail paths', () => {
    expect(expenseIdFromPathname('/expenses/42')).toBe(42)
    expect(expenseIdFromPathname('/expenses/42/')).toBe(42)
    expect(expenseIdFromPathname('/expenses/new')).toBeNull()
    expect(expenseIdFromPathname('/expenses/0')).toBeNull()
  })

  it('[unit] converts direct money and unit categories without floating-point cents', () => {
    expect(expenseAmountCents('123456789.09')).toBe(12_345_678_909)
    expect(expenseValueInput(category(), '19.95')).toEqual({ total_cost_cents: 1995 })
    expect(
      expenseValueInput(
        category({ id: 2, unit_name: 'mile', unit_price_cents: 67 }),
        '125',
      ),
    ).toEqual({ units: 125 })
    expect(expenseUnits('0')).toBe(0)
    expect(() => expenseAmountCents('1.999')).toThrow(/two decimals/u)
    expect(() => expenseUnits('1.5')).toThrow(/whole number/u)
  })

  it('[unit] omits pricing from notes-only patches and sends it only for value/category changes', () => {
    const unitExpense = expense({
      expense_category_id: 2,
      units: 10,
      total_cost_cents: 670,
    })
    const desired = {
      project_id: 1,
      expense_category_id: 2,
      spent_date: '2026-09-01',
      notes: 'Updated note',
      units: 10,
      billable: true,
      reimbursable: true,
    }
    expect(expensePatch(unitExpense, desired)).toEqual({ notes: 'Updated note' })
    expect(expensePatch(unitExpense, { ...desired, units: 11 })).toEqual({
      notes: 'Updated note',
      units: 11,
    })
    expect(
      expensePatch(unitExpense, {
        project_id: desired.project_id,
        expense_category_id: 1,
        spent_date: desired.spent_date,
        notes: desired.notes,
        total_cost_cents: 995,
        billable: desired.billable,
        reimbursable: desired.reimbursable,
      }),
    ).toEqual({
      expense_category_id: 1,
      notes: 'Updated note',
      total_cost_cents: 995,
    })
  })

  it('[unit] keeps submitted expenses editable but closes approved, billed, and policy-locked rows', () => {
    expect(expenseIsEditable(expense({ approval_status: 'submitted' }))).toBe(true)
    expect(expenseIsEditable(expense({ approval_status: 'approved' }))).toBe(false)
    expect(expenseIsEditable(expense({ invoice_id: 7, is_billed: true }))).toBe(false)
    expect(expenseIsEditable(expense({ is_locked: true }))).toBe(false)
  })

  it('[unit] groups dates into stable Monday-through-Sunday expense weeks', () => {
    expect(expenseWeekStart('2026-09-06')).toBe('2026-08-31')
    expect(expenseWeekStart('2026-09-07')).toBe('2026-09-07')
    expect(expenseWeekStart('2026-09-06', 'sunday')).toBe('2026-09-06')
    expect(expenseWeekStart('2026-09-06', 'saturday')).toBe('2026-09-05')
    expect(expenseWeekLabel('2026-09-01')).toContain('Week of Aug 31, 2026')
  })

  it('[unit] accepts only supported URL filters', () => {
    expect(
      filtersFromSearch('?from=2026-09-01&to=2026-09-30&client_id=2&project_id=3&expense_category_id=4&approval_status=submitted&reimbursement_status=pending&ignored=x'),
    ).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      client_id: 2,
      project_id: 3,
      expense_category_id: 4,
      approval_status: 'submitted',
      reimbursement_status: 'pending',
    })
  })
})

describe('what the approval pill is allowed to claim', () => {
  // Fourteen years of book came in from Harvest with thousands of time entries
  // and a handful of expenses marked approved. The import keeps that answer
  // in source_approval_status rather than overwriting the native column,
  // because an instance whose approval module is off resets the native column
  // to unsubmitted for every row. Reading only the native column told a
  // 2012 expense, invoiced and paid, that it had never been submitted.
  it('shows the imported answer when this instance has not decided one', () => {
    const display = expenseApprovalDisplay(
      expense({ approval_status: 'unsubmitted', source_approval_status: 'approved' }),
    )
    expect(display.label).toBe('Approved')
    expect(display.imported).toBe(true)
    expect(display.explanation).toBe(
      'Approved in the system this expense was imported from.',
    )
  })

  it('says submitted for an imported submission, not approved', () => {
    const display = expenseApprovalDisplay(
      expense({ approval_status: 'unsubmitted', source_approval_status: 'submitted' }),
    )
    expect(display.label).toBe('Submitted')
    expect(display.imported).toBe(true)
  })

  // The five expenses that really were unsubmitted in Harvest. Faithful is
  // faithful in both directions: an imported unsubmitted must not be dressed
  // up as anything else.
  it('leaves a genuinely unsubmitted import alone', () => {
    const display = expenseApprovalDisplay(
      expense({ approval_status: 'unsubmitted', source_approval_status: 'unsubmitted' }),
    )
    expect(display.label).toBe('Unsubmitted')
    expect(display.imported).toBe(false)
    expect(display.explanation).toBeNull()
  })

  it('leaves a native row alone', () => {
    const display = expenseApprovalDisplay(
      expense({ approval_status: 'submitted', source_approval_status: null }),
    )
    expect(display.label).toBe('Submitted')
    expect(display.imported).toBe(false)
  })

  // This instance's own decision is the one that counts where it made one.
  // An imported row that has since been approved here is approved here, not
  // "approved (imported)".
  it('prefers this instance when it has decided', () => {
    const display = expenseApprovalDisplay(
      expense({ approval_status: 'approved', source_approval_status: 'submitted' }),
    )
    expect(display.label).toBe('Approved')
    expect(display.imported).toBe(false)
  })
})
