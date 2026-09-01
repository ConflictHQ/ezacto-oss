/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type Attachment,
  type Expense,
  type ExpenseCategory,
  type GeneralResource,
  type Whoami,
} from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createExpenseWorkflowController } from '../src/expenses/browser.js'
import type { ExpenseWorkflowApi } from '../src/expenses/model.js'
import { renderAppShell } from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
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
  ...direct,
  id: 2,
  name: 'Mileage',
  unit_name: 'mile',
  unit_price_cents: 67,
}
const client: GeneralResource = {
  id: 4,
  name: 'Acme',
  currency: 'USD',
  created_at: timestamp,
  updated_at: timestamp,
}
const project: GeneralResource = {
  id: 3,
  client_id: 4,
  name: 'Launch',
  code: 'WEB',
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
}
const baseExpense: Expense = {
  id: 8,
  user_id: 1,
  project_id: 3,
  expense_category_id: 1,
  spent_date: '2026-09-01',
  notes: 'Taxi from airport\nClient kickoff',
  units: null,
  total_cost_cents: 4299,
  billable: true,
  approval_status: 'submitted',
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
}
const receipt: Attachment = {
  id: 9,
  name: 'taxi-receipt.pdf',
  content_hash: 'a'.repeat(64),
  byte_size: 1234,
  content_type: 'application/pdf',
  uploaded_by_user_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
}
const identity: Whoami = {
  user_id: 1,
  profile: 'member',
  manager_grants: [],
  authentication: { kind: 'session' },
}
const page = <Item>(data: readonly Item[]) => ({ data, page: { next_cursor: null } })
const deferred = <Value>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const writeDocument = (view: 'expense-list' | 'expense-detail', pathname: string): void => {
  window.history.replaceState(null, '', pathname)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'expense-browser-test',
      activeSection: 'Expenses',
      view,
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const catalogs = (): Pick<
  ExpenseWorkflowApi,
  | 'getExpenseWeekStartDay'
  | 'listExpenseCategories'
  | 'listExpenseProjects'
  | 'listExpenseClients'
> => ({
  getExpenseWeekStartDay: vi.fn(async (): Promise<'monday'> => 'monday'),
  listExpenseCategories: vi.fn(async () => page([direct, mileage])),
  listExpenseProjects: vi.fn(async () => page([project])),
  listExpenseClients: vi.fn(async () => page([client])),
})

describe('Expenses V1 browser controller', () => {
  it('[browser] applies every supported filter and renders notes in week-grouped cards', async () => {
    writeDocument(
      'expense-list',
      '/expenses?from=2026-09-01&to=2026-09-30&client_id=4&project_id=3&expense_category_id=1&approval_status=submitted&reimbursement_status=pending',
    )
    const listWorkflowExpenses = vi.fn(async () =>
      page([
        baseExpense,
        { ...baseExpense, id: 9, spent_date: '2026-08-25', notes: 'Prior week' },
        { ...baseExpense, id: 10, spent_date: '2026-09-02', notes: 'Later same week' },
      ]),
    )
    const controller = createExpenseWorkflowController({ ...catalogs(), listWorkflowExpenses })

    await controller.activate(identity, new AbortController().signal, () => false)

    expect(listWorkflowExpenses).toHaveBeenCalledWith(
      {
        from: '2026-09-01',
        to: '2026-09-30',
        client_id: 4,
        project_id: 3,
        expense_category_id: 1,
        approval_status: 'submitted',
        reimbursement_status: 'pending',
      },
      undefined,
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Week of Aug 31, 2026')
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Taxi from airport')
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('[WEB] Launch')
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('$42.99')
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Submitted')
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Reimbursement: Pending')
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Billable · not invoiced')
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Editable')
    expect(document.querySelectorAll('.expense-week-heading')).toHaveLength(2)
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-expense-id]')].map(
        (row) => row.dataset.expenseId,
      ),
    ).toEqual(['10', '8', '9'])
  })

  it('[browser] creates direct amounts as cents and unit categories as units', async () => {
    writeDocument('expense-list', '/expenses')
    const createWorkflowExpense = vi.fn(async (input) => ({ ...baseExpense, ...input }))
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      listWorkflowExpenses: vi.fn(async () => page([])),
      createWorkflowExpense,
    })
    await controller.activate(identity, new AbortController().signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-expense-create-form]')!
    ;(form.elements.namedItem('project_id') as HTMLSelectElement).value = '3'
    ;(form.elements.namedItem('spent_date') as HTMLInputElement).value = '2026-09-01'
    ;(form.elements.namedItem('notes') as HTMLTextAreaElement).value = 'Direct receipt detail'
    ;(form.elements.namedItem('expense_value') as HTMLInputElement).value = '19.95'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(createWorkflowExpense).toHaveBeenCalledTimes(1))
    expect(createWorkflowExpense.mock.calls[0]![0]).toEqual({
      project_id: 3,
      expense_category_id: 1,
      spent_date: '2026-09-01',
      notes: 'Direct receipt detail',
      total_cost_cents: 1995,
      billable: false,
      reimbursable: false,
    })
    await vi.waitFor(() => expect(document.querySelector('[data-expense-create-result]')?.textContent).toContain('Expense added'))
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-expense-create-submit]')?.disabled).toBe(false))

    ;(form.elements.namedItem('expense_category_id') as HTMLSelectElement).value = '2'
    ;(form.elements.namedItem('expense_category_id') as HTMLSelectElement).dispatchEvent(new Event('change'))
    expect(document.querySelector('[data-expense-create-value-label]')?.textContent).toContain('Units (mile)')
    ;(form.elements.namedItem('spent_date') as HTMLInputElement).value = '2026-09-02'
    ;(form.elements.namedItem('expense_value') as HTMLInputElement).value = '125'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(createWorkflowExpense).toHaveBeenCalledTimes(2))
    expect(createWorkflowExpense.mock.calls[1]![0]).toMatchObject({
      expense_category_id: 2,
      units: 125,
    })
    expect(createWorkflowExpense.mock.calls[1]![0]).not.toHaveProperty('total_cost_cents')
  })

  it('[browser] edits submitted detail with notes and uploads a receipt through the attachment API', async () => {
    writeDocument('expense-detail', '/expenses/8')
    const updateWorkflowExpense = vi.fn(async (_id, patch) => ({ ...baseExpense, ...patch }))
    const uploadWorkflowExpenseAttachment = vi.fn<
      ExpenseWorkflowApi['uploadWorkflowExpenseAttachment']
    >(async () => receipt)
    const listWorkflowExpenseAttachments = vi
      .fn<ExpenseWorkflowApi['listWorkflowExpenseAttachments']>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([receipt])
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      getWorkflowExpense: vi.fn(async () => baseExpense),
      updateWorkflowExpense,
      listWorkflowExpenseAttachments,
      uploadWorkflowExpenseAttachment,
    })

    await controller.activate(identity, new AbortController().signal, () => false)
    expect(document.querySelector('[data-expense-edit-form]')?.textContent).toContain('Notes')
    expect((document.querySelector('[data-expense-edit-form] [name="notes"]') as HTMLTextAreaElement).value).toContain('Client kickoff')
    expect(document.querySelector('[data-expense-edit-result]')?.textContent).toContain('Submitted expenses remain editable')
    expect(document.querySelector<HTMLButtonElement>('[data-expense-attachment-submit]')?.disabled).toBe(false)

    const editForm = document.querySelector<HTMLFormElement>('[data-expense-edit-form]')!
    ;(editForm.elements.namedItem('notes') as HTMLTextAreaElement).value = 'Updated submitted receipt note'
    editForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updateWorkflowExpense).toHaveBeenCalledTimes(1))
    expect(updateWorkflowExpense.mock.calls[0]![1]).toEqual({
      notes: 'Updated submitted receipt note',
    })
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-expense-edit-submit]')?.disabled).toBe(false))
    expect(document.querySelector<HTMLButtonElement>('[data-expense-attachment-submit]')?.disabled).toBe(false)

    const file = new File(['receipt bytes'], 'taxi-receipt.pdf', { type: 'application/pdf' })
    const fileInput = document.querySelector<HTMLInputElement>('[data-expense-attachment-form] input[type="file"]')!
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    expect(fileInput.files?.[0]?.size).toBeGreaterThan(0)
    const attachmentForm = document.querySelector<HTMLFormElement>('[data-expense-attachment-form]')!
    attachmentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-expense-attachment-status]')?.textContent).not.toBe(''))
    await vi.waitFor(() => expect(uploadWorkflowExpenseAttachment).toHaveBeenCalledTimes(1))
    expect(uploadWorkflowExpenseAttachment.mock.calls[0]![0]).toBe(8)
    expect(uploadWorkflowExpenseAttachment.mock.calls[0]![1]).toMatch(/^web\.expense\.attachment:/u)
    await vi.waitFor(() => expect(document.querySelector('[data-expense-attachments]')?.textContent).toContain('taxi-receipt.pdf'))
    expect(document.querySelector<HTMLAnchorElement>('[data-expense-attachments] a')?.href).toContain('/api/v1/expenses/8/attachments/9/content')
  })

  it('[browser] preserves stored unit economics when only notes change on an archived category', async () => {
    writeDocument('expense-detail', '/expenses/8')
    const archivedMileage = { ...mileage, unit_price_cents: 70, is_active: false }
    const stored = {
      ...baseExpense,
      expense_category_id: 2,
      units: 10,
      total_cost_cents: 670,
    }
    const updateWorkflowExpense = vi.fn(async (_id, patch) => ({ ...stored, ...patch }))
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      listExpenseCategories: vi.fn(async () => page([direct, archivedMileage])),
      getWorkflowExpense: vi.fn(async () => stored),
      updateWorkflowExpense,
      listWorkflowExpenseAttachments: vi.fn(async () => []),
    })
    await controller.activate(identity, new AbortController().signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-expense-edit-form]')!
    ;(form.elements.namedItem('notes') as HTMLTextAreaElement).value = 'Notes only after price change'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateWorkflowExpense).toHaveBeenCalledTimes(1))
    expect(updateWorkflowExpense.mock.calls[0]![1]).toEqual({
      notes: 'Notes only after price change',
    })
  })

  it('[browser] explains and disables approved or policy-locked mutations', async () => {
    writeDocument('expense-detail', '/expenses/8')
    const locked = {
      ...baseExpense,
      approval_status: 'approved' as const,
      is_locked: true,
      locked_reason: 'Closed by the September deadline.',
    }
    const updateWorkflowExpense = vi.fn()
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      getWorkflowExpense: vi.fn(async () => locked),
      updateWorkflowExpense,
      listWorkflowExpenseAttachments: vi.fn(async () => []),
    })
    await controller.activate(identity, new AbortController().signal, () => false)

    expect(document.querySelector('[data-expense-lock-message]')?.textContent).toBe('Closed by the September deadline.')
    expect(document.querySelector<HTMLButtonElement>('[data-expense-edit-submit]')?.hidden).toBe(true)
    expect(
      [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-expense-edit-form] input, [data-expense-edit-form] select, [data-expense-edit-form] textarea')]
        .every((field) => field.disabled),
    ).toBe(true)
    expect(updateWorkflowExpense).not.toHaveBeenCalled()
  })

  it('[browser] surfaces a server-side lock race and hands a 401 back to session recovery', async () => {
    writeDocument('expense-detail', '/expenses/8')
    const updateWorkflowExpense = vi
      .fn<ExpenseWorkflowApi['updateWorkflowExpense']>()
      .mockRejectedValueOnce(
        new EzactoApiError(
          422,
          {
            error: {
              code: 'tracked_mutation_locked',
              message: 'The expense is locked.',
              fields: [
                {
                  field: 'expense',
                  code: 'policy_locked',
                  message: 'The September close now locks this expense.',
                },
              ],
            },
          },
          'lock-race',
        ),
      )
      .mockRejectedValueOnce(
        new EzactoApiError(
          401,
          { error: { code: 'authentication_required', fields: [] } },
          'expired-session',
        ),
      )
    const onSessionFailure = vi.fn(() => true)
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      getWorkflowExpense: vi.fn(async () => baseExpense),
      updateWorkflowExpense,
      listWorkflowExpenseAttachments: vi.fn(async () => []),
    })
    await controller.activate(identity, new AbortController().signal, onSessionFailure)
    const form = document.querySelector<HTMLFormElement>('[data-expense-edit-form]')!

    ;(form.elements.namedItem('notes') as HTMLTextAreaElement).value = 'First attempted update'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-expense-edit-result]')?.textContent).toBe(
        'The September close now locks this expense.',
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('[data-expense-edit-submit]')?.disabled).toBe(false),
    )

    ;(form.elements.namedItem('notes') as HTMLTextAreaElement).value = 'Second attempted update'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(onSessionFailure).toHaveBeenCalledTimes(1))
    expect(document.querySelector<HTMLButtonElement>('[data-expense-edit-submit]')?.disabled).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-expense-detail]')?.hidden).toBe(true)
  })

  it('[security] clears private detail state on abort before a different session catalog can fail', async () => {
    writeDocument('expense-detail', '/expenses/8')
    const listExpenseCategories = vi
      .fn<ExpenseWorkflowApi['listExpenseCategories']>()
      .mockResolvedValueOnce(page([direct, mileage]))
      .mockRejectedValueOnce(new Error('Catalog offline'))
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      listExpenseCategories,
      getWorkflowExpense: vi.fn(async () => baseExpense),
      listWorkflowExpenseAttachments: vi.fn(async () => [receipt]),
    })
    const first = new AbortController()
    await controller.activate(identity, first.signal, () => false)
    expect((document.querySelector('[data-expense-edit-form] [name="notes"]') as HTMLTextAreaElement).value).toContain('Client kickoff')
    expect(document.querySelector('[data-expense-attachments]')?.textContent).toContain('taxi-receipt.pdf')

    first.abort()
    expect((document.querySelector('[data-expense-edit-form] [name="notes"]') as HTMLTextAreaElement).value).toBe('')
    expect(document.querySelector<HTMLElement>('[data-expense-detail]')?.hidden).toBe(true)
    expect(document.querySelector('[data-expense-attachments]')?.textContent).toBe('')

    await controller.activate(
      { ...identity, user_id: 2 },
      new AbortController().signal,
      () => false,
    )
    expect(document.querySelector('[data-expense-detail-status]')?.textContent).toBe('Catalog offline')
    expect((document.querySelector('[data-expense-edit-form] [name="notes"]') as HTMLTextAreaElement).value).toBe('')
    expect(document.querySelector<HTMLElement>('[data-expense-detail]')?.hidden).toBe(true)
  })

  it('[security] resets mutation ownership between activations and ignores the old result', async () => {
    writeDocument('expense-detail', '/expenses/8')
    const oldUpdate = deferred<Expense>()
    const updateWorkflowExpense = vi
      .fn<ExpenseWorkflowApi['updateWorkflowExpense']>()
      .mockImplementationOnce(async () => oldUpdate.promise)
      .mockImplementationOnce(async (_id, patch) => ({
        ...baseExpense,
        user_id: 2,
        ...patch,
      }))
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      getWorkflowExpense: vi
        .fn<ExpenseWorkflowApi['getWorkflowExpense']>()
        .mockResolvedValueOnce(baseExpense)
        .mockResolvedValueOnce({ ...baseExpense, user_id: 2, notes: 'Second user note' }),
      updateWorkflowExpense,
      listWorkflowExpenseAttachments: vi.fn(async () => []),
    })
    const first = new AbortController()
    await controller.activate(identity, first.signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-expense-edit-form]')!
    ;(form.elements.namedItem('notes') as HTMLTextAreaElement).value = 'First user pending secret'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updateWorkflowExpense).toHaveBeenCalledTimes(1))

    first.abort()
    await controller.activate(
      { ...identity, user_id: 2 },
      new AbortController().signal,
      () => false,
    )
    ;(form.elements.namedItem('notes') as HTMLTextAreaElement).value = 'Second user saved note'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updateWorkflowExpense).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect((form.elements.namedItem('notes') as HTMLTextAreaElement).value).toBe('Second user saved note'))

    oldUpdate.resolve({ ...baseExpense, notes: 'First user stale secret' })
    await Promise.resolve()
    await Promise.resolve()
    expect((form.elements.namedItem('notes') as HTMLTextAreaElement).value).toBe('Second user saved note')
  })

  it('[browser] replaces an in-flight list when filters change and rejects the stale response', async () => {
    writeDocument('expense-list', '/expenses')
    const initial = deferred<ReturnType<typeof page<Expense>>>()
    const filtered = deferred<ReturnType<typeof page<Expense>>>()
    const listWorkflowExpenses = vi
      .fn<ExpenseWorkflowApi['listWorkflowExpenses']>()
      .mockImplementationOnce(async () => initial.promise)
      .mockImplementationOnce(async () => filtered.promise)
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      listWorkflowExpenses,
    })
    const activation = controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(listWorkflowExpenses).toHaveBeenCalledTimes(1))
    const filter = document.querySelector<HTMLFormElement>('[data-expense-filter-form]')!
    ;(filter.elements.namedItem('from') as HTMLInputElement).value = '2026-09-01'
    filter.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(listWorkflowExpenses).toHaveBeenCalledTimes(2))
    expect(listWorkflowExpenses.mock.calls[1]![0]).toEqual({ from: '2026-09-01' })

    initial.resolve(page([{ ...baseExpense, notes: 'Stale unfiltered secret' }]))
    await activation
    expect(document.querySelector('[data-expense-list]')?.textContent).not.toContain('Stale unfiltered secret')
    filtered.resolve(page([{ ...baseExpense, id: 10, notes: 'Fresh filtered row' }]))
    await vi.waitFor(() => expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Fresh filtered row'))
    expect(document.querySelector('[data-expense-list]')?.textContent).not.toContain('Stale unfiltered secret')
  })

  it('[browser] retries catalogs together with the page after catalog failure', async () => {
    writeDocument('expense-list', '/expenses')
    const listExpenseCategories = vi
      .fn<ExpenseWorkflowApi['listExpenseCategories']>()
      .mockRejectedValueOnce(new Error('Catalog unavailable'))
      .mockResolvedValueOnce(page([direct, mileage]))
    const listWorkflowExpenses = vi.fn(async () => page([baseExpense]))
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      listExpenseCategories,
      listWorkflowExpenses,
    })
    await controller.activate(identity, new AbortController().signal, () => false)
    expect(listWorkflowExpenses).not.toHaveBeenCalled()
    expect(document.querySelector('[data-expense-list-status]')?.textContent).toBe('Catalog unavailable')

    document.querySelector<HTMLButtonElement>('[data-expense-list-retry]')!.click()
    await vi.waitFor(() => expect(listExpenseCategories).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(listWorkflowExpenses).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-expense-list]')?.textContent).toContain('Travel')
  })

  it('[browser] renders an honest unavailable state when the expenses module is disabled', async () => {
    writeDocument('expense-list', '/expenses')
    const controller = createExpenseWorkflowController({
      ...catalogs(),
      listWorkflowExpenses: vi.fn(async () => {
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
    })
    await controller.activate(identity, new AbortController().signal, () => false)

    expect(document.querySelector<HTMLElement>('[data-expense-module-unavailable]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-expense-create-panel]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLFormElement>('[data-expense-filter-form]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLOListElement>('[data-expense-list]')?.hidden).toBe(true)
    expect(document.querySelector('[data-expense-list-status]')?.textContent).toContain('not enabled')
  })
})
