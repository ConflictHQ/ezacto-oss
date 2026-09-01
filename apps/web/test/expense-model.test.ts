import type { Expense, ExpenseCategory } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  expenseAmountCents,
  expenseIdFromPathname,
  expenseIsEditable,
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
