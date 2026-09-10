/** @vitest-environment happy-dom */

import { EzactoApiError, type ExpenseCategory, type Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createExpenseCategoryDirectoryController } from '../src/expense-categories/browser.js'
import type { ExpenseCategoryDirectoryApi } from '../src/expense-categories/model.js'
import { renderAppShell } from '../src/index.js'

const timestamp = '2026-09-02T12:00:00.000Z'
const direct: ExpenseCategory = {
  id: 1,
  name: 'Travel',
  unit_name: null,
  unit_price_cents: null,
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
}
const mileage: ExpenseCategory = {
  id: 2,
  name: 'Mileage',
  unit_name: 'mile',
  unit_price_cents: 67,
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
}

const identity = (profile: Whoami['profile'], userId = 1): Whoami => ({
  user_id: userId,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

const page = (data: readonly ExpenseCategory[], nextCursor: string | null = null) => ({
  data,
  page: { next_cursor: nextCursor },
})

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const writeDocument = (path = '/expense-categories'): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'expense-category-browser-test',
      activeSection: 'Expenses',
      view: 'expense-categories',
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const baseApi = (
  overrides: Partial<ExpenseCategoryDirectoryApi> = {},
): Partial<ExpenseCategoryDirectoryApi> => ({
  listDirectoryExpenseCategories: vi.fn(async () => page([direct, mileage])),
  createDirectoryExpenseCategory: vi.fn(async (input) => ({
    id: 3,
    is_active: true,
    created_at: timestamp,
    updated_at: timestamp,
    unit_name: null,
    unit_price_cents: null,
    ...input,
  })),
  updateDirectoryExpenseCategory: vi.fn(async (id, patch) => ({
    ...(id === direct.id ? direct : mileage),
    ...patch,
  })),
  archiveDirectoryExpenseCategory: vi.fn(async (id) => ({
    ...(id === direct.id ? direct : mileage),
    is_active: false,
  })),
  ...overrides,
})

describe('Expense category browser controller', () => {
  it('[browser] pages the active category directory', async () => {
    writeDocument()
    const listDirectoryExpenseCategories = vi
      .fn<ExpenseCategoryDirectoryApi['listDirectoryExpenseCategories']>()
      .mockResolvedValueOnce(page([direct], 'next'))
      .mockResolvedValueOnce(page([mileage]))
    await createExpenseCategoryDirectoryController(
      baseApi({ listDirectoryExpenseCategories }),
    ).activate(identity('administrator'), new AbortController().signal, () => false)

    expect(listDirectoryExpenseCategories).toHaveBeenCalledWith(
      true,
      undefined,
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
      'Travel',
    )
    document.querySelector<HTMLButtonElement>('[data-expense-category-load-more]')!.click()
    await vi.waitFor(() => expect(listDirectoryExpenseCategories).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
        'Mileage',
      ),
    )
    expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
      '67 cents per mile',
    )
  })

  it('[browser] creates exact unit pricing, edits to direct amount, and archives only on confirm', async () => {
    writeDocument()
    let categories: ExpenseCategory[] = [direct]
    const listDirectoryExpenseCategories = vi.fn(async (activeOnly: boolean) =>
      page(categories.filter((category) => !activeOnly || category.is_active)),
    )
    const createDirectoryExpenseCategory = vi.fn(async (input) => {
      const created: ExpenseCategory = {
        id: 3,
        is_active: true,
        created_at: timestamp,
        updated_at: timestamp,
        unit_name: null,
        unit_price_cents: null,
        ...input,
      }
      categories = [...categories, created]
      return created
    })
    const updateDirectoryExpenseCategory = vi.fn(async (id, patch) => {
      const current = categories.find((category) => category.id === id)!
      const updated = { ...current, ...patch }
      categories = categories.map((category) => (category.id === id ? updated : category))
      return updated
    })
    const archiveDirectoryExpenseCategory = vi.fn(async (id) => {
      const current = categories.find((category) => category.id === id)!
      const archived = { ...current, is_active: false }
      categories = categories.map((category) => (category.id === id ? archived : category))
      return archived
    })
    const controller = createExpenseCategoryDirectoryController(
      baseApi({
        listDirectoryExpenseCategories,
        createDirectoryExpenseCategory,
        updateDirectoryExpenseCategory,
        archiveDirectoryExpenseCategory,
      }),
    )
    await controller.activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    const create = document.querySelector<HTMLFormElement>(
      '[data-expense-category-create-form]',
    )!
    ;(create.elements.namedItem('name') as HTMLInputElement).value = 'Mileage UI'
    ;(create.elements.namedItem('mode') as HTMLSelectElement).value = 'unit'
    ;(create.elements.namedItem('mode') as HTMLSelectElement).dispatchEvent(
      new Event('change', { bubbles: true }),
    )
    ;(create.elements.namedItem('unit_price_cents') as HTMLInputElement).value = '42'
    create.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(createDirectoryExpenseCategory).not.toHaveBeenCalled()
    expect(document.querySelector('[data-expense-category-create-result]')?.textContent).toContain(
      'unit name',
    )

    ;(create.elements.namedItem('unit_name') as HTMLInputElement).value = 'km'
    create.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(createDirectoryExpenseCategory).toHaveBeenCalledTimes(1))
    expect(createDirectoryExpenseCategory.mock.calls[0]![0]).toEqual({
      name: 'Mileage UI',
      unit_name: 'km',
      unit_price_cents: 42,
    })
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
        '42 cents per km',
      ),
    )

    const row = document.querySelector<HTMLElement>('[data-row-key="3"]')!
    ;[...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!.click()
    const edit = document.querySelector<HTMLFormElement>('[data-expense-category-edit-form]')!
    ;(edit.elements.namedItem('mode') as HTMLSelectElement).value = 'direct'
    ;(edit.elements.namedItem('mode') as HTMLSelectElement).dispatchEvent(
      new Event('change', { bubbles: true }),
    )
    edit.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updateDirectoryExpenseCategory).toHaveBeenCalledTimes(1))
    expect(updateDirectoryExpenseCategory.mock.calls[0]![1]).toEqual({
      name: 'Mileage UI',
      unit_name: null,
      unit_price_cents: null,
    })

    await vi.waitFor(() =>
      expect(document.querySelector('[data-row-key="3"]')).not.toBeNull(),
    )
    const refreshedRow = document.querySelector<HTMLElement>('[data-row-key="3"]')!
    ;[...refreshedRow.querySelectorAll('button')]
      .find((button) => button.textContent === 'Archive')!
      .click()
    const archiveDialog = document.querySelector<HTMLDialogElement>(
      '[data-expense-category-archive-dialog]',
    )!
    archiveDialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()
    expect(archiveDirectoryExpenseCategory).not.toHaveBeenCalled()

    ;[...refreshedRow.querySelectorAll('button')]
      .find((button) => button.textContent === 'Archive')!
      .click()
    archiveDialog
      .querySelector<HTMLButtonElement>('button[value="cancel"]')!
      .click()
    expect(archiveDirectoryExpenseCategory).not.toHaveBeenCalled()

    ;[...refreshedRow.querySelectorAll('button')]
      .find((button) => button.textContent === 'Archive')!
      .click()
    archiveDialog
      .querySelector<HTMLButtonElement>('button[value="confirm"]')!
      .click()
    await vi.waitFor(() => expect(archiveDirectoryExpenseCategory).toHaveBeenCalledWith(3, expect.any(AbortSignal)))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-category-list]')?.textContent).not.toContain(
        'Mileage UI',
      ),
    )

    document.querySelector<HTMLButtonElement>('[data-expense-category-filter="all"]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-row-key="3"]')?.textContent).toContain(
        'Archived',
      ),
    )
    expect(window.location.search).toBe('?status=all')
  })

  it('[browser #486] restores an archived category into the active list without confirming', async () => {
    // Archived is the majority state on a migrated account, so the archived row
    // is the one an operator meets first -- and until now the only way out of it
    // was a token and a terminal.
    writeDocument('/expense-categories?status=all')
    let categories: ExpenseCategory[] = [{ ...direct, is_active: false }]
    const listDirectoryExpenseCategories = vi.fn(async (activeOnly: boolean) =>
      page(categories.filter((category) => !activeOnly || category.is_active)),
    )
    const updateDirectoryExpenseCategory = vi.fn(async (id: number, patch) => {
      const current = categories.find((category) => category.id === id)!
      const updated = { ...current, ...patch }
      categories = categories.map((category) => (category.id === id ? updated : category))
      return updated
    })
    const archiveDirectoryExpenseCategory = vi.fn(async () => direct)
    await createExpenseCategoryDirectoryController(
      baseApi({
        listDirectoryExpenseCategories,
        updateDirectoryExpenseCategory,
        archiveDirectoryExpenseCategory,
      }),
    ).activate(identity('administrator'), new AbortController().signal, () => false)

    const archived = document.querySelector<HTMLElement>('[data-row-key="1"]')!
    expect([...archived.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Edit',
      'Restore',
    ])
    ;[...archived.querySelectorAll('button')]
      .find((button) => button.textContent === 'Restore')!
      .click()

    await vi.waitFor(() =>
      expect(updateDirectoryExpenseCategory).toHaveBeenCalledWith(
        1,
        { is_active: true },
        expect.any(AbortSignal),
      ),
    )
    expect(
      document.querySelector<HTMLDialogElement>('[data-expense-category-archive-dialog]')!.open,
    ).toBe(false)
    expect(archiveDirectoryExpenseCategory).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-category-status]')?.textContent).toBe(
        'Category restored.',
      ),
    )
    const restored = document.querySelector<HTMLElement>('[data-row-key="1"]')!
    expect(restored.textContent).toContain('Active')
    expect([...restored.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Edit',
      'Archive',
    ])

    document.querySelector<HTMLButtonElement>('[data-expense-category-filter="active"]')!.click()
    await vi.waitFor(() =>
      expect(listDirectoryExpenseCategories).toHaveBeenLastCalledWith(
        true,
        undefined,
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
        'Travel',
      ),
    )
  })

  it('[security] lets expense readers view categories without rendering mutation controls', async () => {
    writeDocument('/expense-categories?status=all')
    const api = baseApi()
    await createExpenseCategoryDirectoryController(api).activate(
      identity('member'),
      new AbortController().signal,
      () => false,
    )

    expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
      'Travel',
    )
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-expense-category-write]')].every(
        (item) => item.hidden,
      ),
    ).toBe(true)
    expect(document.querySelector('[data-expense-category-list] button')).toBeNull()
    expect(api.createDirectoryExpenseCategory).not.toHaveBeenCalled()
    expect(api.updateDirectoryExpenseCategory).not.toHaveBeenCalled()
    expect(api.archiveDirectoryExpenseCategory).not.toHaveBeenCalled()
  })

  it('[security] keeps an administrator API token read-only', async () => {
    writeDocument('/expense-categories?status=all')
    const api = baseApi()
    await createExpenseCategoryDirectoryController(api).activate(
      {
        ...identity('administrator'),
        authentication: { kind: 'token', token_id: 4, scopes: ['expenses:read'] },
      },
      new AbortController().signal,
      () => false,
    )

    expect(api.listDirectoryExpenseCategories).toHaveBeenCalledWith(
      false,
      undefined,
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
      'Travel',
    )
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-expense-category-write]')].every(
        (item) => item.hidden,
      ),
    ).toBe(true)
    expect(document.querySelector('[data-expense-category-list] button')).toBeNull()
    expect(api.createDirectoryExpenseCategory).not.toHaveBeenCalled()
    expect(api.updateDirectoryExpenseCategory).not.toHaveBeenCalled()
    expect(api.archiveDirectoryExpenseCategory).not.toHaveBeenCalled()
  })

  it('[security] rejects a late session-A page after session B handles popstate', async () => {
    writeDocument()
    const oldPage = deferred<ReturnType<typeof page>>()
    const listDirectoryExpenseCategories = vi
      .fn<ExpenseCategoryDirectoryApi['listDirectoryExpenseCategories']>()
      .mockImplementationOnce(async () => oldPage.promise)
      .mockResolvedValueOnce(page([{ ...mileage, id: 20, name: 'Session B category' }]))
      .mockResolvedValueOnce(
        page([
          { ...mileage, id: 20, name: 'Session B category' },
          { ...direct, id: 21, name: 'Session B archived', is_active: false },
        ]),
      )
    const controller = createExpenseCategoryDirectoryController(
      baseApi({ listDirectoryExpenseCategories }),
    )
    const first = new AbortController()
    const firstActivation = controller.activate(identity('administrator'), first.signal, () => false)
    await vi.waitFor(() => expect(listDirectoryExpenseCategories).toHaveBeenCalledTimes(1))

    first.abort()
    const second = new AbortController()
    await controller.activate(identity('administrator', 2), second.signal, () => false)
    oldPage.resolve(page([{ ...direct, id: 10, name: 'Session A secret' }]))
    await firstActivation
    window.history.pushState(null, '', '/expense-categories?status=all')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.waitFor(() => expect(listDirectoryExpenseCategories).toHaveBeenCalledTimes(3))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
        'Session B archived',
      ),
    )
    expect(document.querySelector('[data-expense-category-list]')?.textContent).not.toContain(
      'Session A secret',
    )
    second.abort()
  })

  it('[security] ignores a rejected session-A mutation after session B is active', async () => {
    writeDocument()
    const oldCreate = deferred<ExpenseCategory>()
    const createDirectoryExpenseCategory = vi
      .fn<ExpenseCategoryDirectoryApi['createDirectoryExpenseCategory']>()
      .mockImplementationOnce(async () => oldCreate.promise)
    const listDirectoryExpenseCategories = vi
      .fn<ExpenseCategoryDirectoryApi['listDirectoryExpenseCategories']>()
      .mockResolvedValueOnce(page([direct]))
      .mockResolvedValueOnce(page([{ ...mileage, id: 20, name: 'Session B category' }]))
    const controller = createExpenseCategoryDirectoryController(
      baseApi({ listDirectoryExpenseCategories, createDirectoryExpenseCategory }),
    )
    const firstFailure = vi.fn(() => false)
    const first = new AbortController()
    await controller.activate(identity('administrator'), first.signal, firstFailure)
    const create = document.querySelector<HTMLFormElement>(
      '[data-expense-category-create-form]',
    )!
    ;(create.elements.namedItem('name') as HTMLInputElement).value = 'Session A secret'
    create.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(createDirectoryExpenseCategory).toHaveBeenCalledTimes(1))

    first.abort()
    const secondFailure = vi.fn(() => false)
    const second = new AbortController()
    await controller.activate(identity('administrator', 2), second.signal, secondFailure)
    expect((create.elements.namedItem('name') as HTMLInputElement).value).toBe('')
    expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
      'Session B category',
    )

    oldCreate.reject(
      new EzactoApiError(
        401,
        { error: { code: 'invalid_session', message: 'Old session ended.', fields: [] } },
        'old-session',
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(firstFailure).not.toHaveBeenCalled()
    expect(secondFailure).not.toHaveBeenCalled()
    expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
      'Session B category',
    )
    expect(document.body.textContent).not.toContain('Old session ended.')
    second.abort()
  })

  it('[browser] replaces an in-flight history page when popstate changes the filter', async () => {
    writeDocument()
    const allPage = deferred<ReturnType<typeof page>>()
    const activePage = deferred<ReturnType<typeof page>>()
    const listDirectoryExpenseCategories = vi
      .fn<ExpenseCategoryDirectoryApi['listDirectoryExpenseCategories']>()
      .mockResolvedValueOnce(page([direct]))
      .mockImplementationOnce(async () => allPage.promise)
      .mockImplementationOnce(async () => activePage.promise)
    const session = new AbortController()
    await createExpenseCategoryDirectoryController(
      baseApi({ listDirectoryExpenseCategories }),
    ).activate(identity('administrator'), session.signal, () => false)

    document.querySelector<HTMLButtonElement>('[data-expense-category-filter="all"]')!.click()
    await vi.waitFor(() => expect(listDirectoryExpenseCategories).toHaveBeenCalledTimes(2))
    window.history.pushState(null, '', '/expense-categories')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.waitFor(() => expect(listDirectoryExpenseCategories).toHaveBeenCalledTimes(3))
    activePage.resolve(page([{ ...direct, name: 'Newest active category' }]))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-category-list]')?.textContent).toContain(
        'Newest active category',
      ),
    )
    allPage.resolve(page([{ ...mileage, name: 'Stale archived history' }]))
    await Promise.resolve()
    expect(document.querySelector('[data-expense-category-list]')?.textContent).not.toContain(
      'Stale archived history',
    )
    expect(
      document.querySelector('[data-expense-category-filter="active"]')?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('true')
    session.abort()
  })

  it('[browser] renders the expenses-module unavailable response without retrying', async () => {
    writeDocument()
    await createExpenseCategoryDirectoryController(
      baseApi({
        listDirectoryExpenseCategories: vi.fn(async () => {
          throw new EzactoApiError(
            403,
            {
              error: {
                code: 'module_disabled',
                message: 'The expenses module is not enabled for this organization.',
                fields: [],
              },
            },
            'module-disabled',
          )
        }),
      }),
    ).activate(identity('administrator'), new AbortController().signal, () => false)

    expect(
      document.querySelector<HTMLElement>('[data-expense-category-module-unavailable]')
        ?.hidden,
    ).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-expense-category-content]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector<HTMLButtonElement>('[data-expense-category-retry]')?.hidden).toBe(
      true,
    )
  })
})
