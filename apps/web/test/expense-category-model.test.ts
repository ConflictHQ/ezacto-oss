import type { ExpenseCategory, EzactoClient } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createShellApi } from '../src/index.js'
import {
  expenseCategoryCanWrite,
  expenseCategoryFilterFromUrl,
  expenseCategoryFilterUrl,
  expenseCategoryInput,
  expenseCategoryMode,
  expenseCategoryPricingLabel,
  expenseCategoryUnitPriceCents,
} from '../src/expense-categories/model.js'

const category = (overrides: Partial<ExpenseCategory> = {}): ExpenseCategory => ({
  id: 1,
  name: 'Travel',
  unit_name: null,
  unit_price_cents: null,
  is_active: true,
  created_at: '2026-09-02T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
  ...overrides,
})

describe('Expense category UI model', () => {
  it('allows category writes only from an administrator session', () => {
    expect(
      expenseCategoryCanWrite({
        profile: 'administrator',
        authentication: { kind: 'session' },
      }),
    ).toBe(true)
    expect(
      expenseCategoryCanWrite({
        profile: 'administrator',
        authentication: { kind: 'token', token_id: 4, scopes: ['expenses:read'] },
      }),
    ).toBe(false)
    expect(
      expenseCategoryCanWrite({ profile: 'member', authentication: { kind: 'session' } }),
    ).toBe(false)
  })

  it('maps directory operations to the generated client and archives with an explicit patch', async () => {
    const response = { data: category(), links: { self: '/api/v1/expense-categories/1' } }
    const listResponse = { data: [category()], links: {}, page: { next_cursor: null } }
    const generated = {
      listExpenseCategories: vi.fn(async () => listResponse),
      createExpenseCategory: vi.fn(async () => response),
      updateExpenseCategory: vi.fn(async () => response),
    }
    const api = createShellApi(generated as unknown as EzactoClient)
    const signal = new AbortController().signal

    await api.listDirectoryExpenseCategories!(true, 'active-cursor', signal)
    await api.listDirectoryExpenseCategories!(false, undefined, signal)
    await api.createDirectoryExpenseCategory!({ name: 'Travel' }, signal)
    await api.updateDirectoryExpenseCategory!(1, { name: 'Updated travel' }, signal)
    await api.archiveDirectoryExpenseCategory!(1, signal)

    expect(generated.listExpenseCategories).toHaveBeenNthCalledWith(1, {
      query: { per_page: 50, is_active: true, cursor: 'active-cursor' },
      signal,
    })
    expect(generated.listExpenseCategories).toHaveBeenNthCalledWith(2, {
      query: { per_page: 50 },
      signal,
    })
    expect(generated.createExpenseCategory).toHaveBeenCalledWith({
      body: { name: 'Travel' },
      signal,
    })
    expect(generated.updateExpenseCategory).toHaveBeenNthCalledWith(1, {
      id: 1,
      body: { name: 'Updated travel' },
      signal,
    })
    expect(generated.updateExpenseCategory).toHaveBeenNthCalledWith(2, {
      id: 1,
      body: { is_active: false },
      signal,
    })
  })

  it('round-trips the supported active/all URL filter', () => {
    expect(expenseCategoryFilterFromUrl(new URL('https://example.test/expense-categories'))).toBe(
      'active',
    )
    expect(
      expenseCategoryFilterFromUrl(
        new URL('https://example.test/expense-categories?status=all'),
      ),
    ).toBe('all')
    expect(
      expenseCategoryFilterFromUrl(
        new URL('https://example.test/expense-categories?status=archived'),
      ),
    ).toBe('active')
    expect(expenseCategoryFilterUrl('active')).toBe('/expense-categories')
    expect(expenseCategoryFilterUrl('all')).toBe('/expense-categories?status=all')
  })

  it('builds direct-amount categories with both unit fields explicitly null', () => {
    expect(
      expenseCategoryInput({
        name: '  Travel  ',
        mode: 'direct',
        unitName: 'ignored',
        unitPriceCents: '999',
      }),
    ).toEqual({ name: 'Travel', unit_name: null, unit_price_cents: null })
  })

  it('builds unit categories from exact bounded integer cents', () => {
    expect(
      expenseCategoryInput({
        name: 'Mileage',
        mode: 'unit',
        unitName: ' mile ',
        unitPriceCents: '67',
      }),
    ).toEqual({ name: 'Mileage', unit_name: 'mile', unit_price_cents: 67 })
    expect(expenseCategoryUnitPriceCents('9000000000000')).toBe(9_000_000_000_000)
    for (const value of ['', '-1', '1.2', '9000000000001']) {
      expect(() => expenseCategoryUnitPriceCents(value)).toThrow()
    }
  })

  it('requires unit name and unit price as a pair for unit categories', () => {
    expect(() =>
      expenseCategoryInput({
        name: 'Mileage',
        mode: 'unit',
        unitName: '',
        unitPriceCents: '67',
      }),
    ).toThrow('Enter a unit name')
    expect(() =>
      expenseCategoryInput({
        name: 'Mileage',
        mode: 'unit',
        unitName: 'mile',
        unitPriceCents: '',
      }),
    ).toThrow('exact cents')
  })

  it('describes direct, unit-priced, and inconsistent imported categories honestly', () => {
    expect(expenseCategoryMode(category())).toBe('direct')
    expect(expenseCategoryPricingLabel(category())).toBe('Amount entered on each expense')
    expect(
      expenseCategoryPricingLabel(
        category({ name: 'Mileage', unit_name: 'mile', unit_price_cents: 67 }),
      ),
    ).toBe('67 cents per mile')
    expect(expenseCategoryPricingLabel(category({ unit_name: 'mile' }))).toBe(
      'Incomplete unit pricing',
    )
  })
})
