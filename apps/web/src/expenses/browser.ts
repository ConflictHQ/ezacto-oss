import { renderDataTable } from '../components/data-table.js'
import { icon } from '../components/icons.js'
import {
  EzactoApiError,
  type Attachment,
  type Expense,
  type ExpenseCategory,
  type ExpenseInput,
  type ExpensePatch,
  type GeneralResource,
  type Whoami,
} from '@ezacto/client'
import {
  expenseCategoryLabel,
  expenseClientLabel,
  expenseCurrency,
  expenseIdFromPathname,
  expenseIsEditable,
  expenseLockExplanation,
  expenseMoney,
  expensePatch,
  expenseProjectLabel,
  expenseResourceNumber,
  expenseResourceText,
  expenseStatusLabel,
  expenseValueForForm,
  expenseValueInput,
  expenseWeekLabel,
  filtersFromSearch,
  type ExpenseFilters,
  type ExpensePage,
  type ExpenseWorkflowApi,
  type ExpenseWeekStartDay,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const result = document.querySelector<ElementType>(selector)
  if (result === null) throw new Error(`expense workflow element missing: ${selector}`)
  return result
}

const apiMessage = (error: unknown): string => {
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      const fields = Reflect.get(detail, 'fields')
      if (Array.isArray(fields)) {
        const field = fields.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            typeof Reflect.get(candidate, 'message') === 'string',
        )
        if (field !== undefined) return String(Reflect.get(field, 'message'))
      }
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  }
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

const collect = async <Item>(
  load: (cursor?: string) => Promise<ExpensePage<Item>>,
  signal: AbortSignal,
): Promise<Item[]> => {
  const items: Item[] = []
  let cursor: string | undefined
  do {
    signal.throwIfAborted()
    const page = await load(cursor)
    items.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return items
}

const option = (value: number, text: string): HTMLOptionElement => {
  const result = document.createElement('option')
  result.value = String(value)
  result.textContent = text
  return result
}

const selectedId = (form: HTMLFormElement, name: string): number => {
  const field = form.elements.namedItem(name)
  const value = field instanceof HTMLSelectElement ? Number(field.value) : Number.NaN
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Choose a valid ${name.replace('_id', '')}.`)
  return value
}

const formInput = (form: HTMLFormElement, name: string): HTMLInputElement => {
  const field = form.elements.namedItem(name)
  if (!(field instanceof HTMLInputElement)) throw new Error(`expense input missing: ${name}`)
  return field
}

const formSelect = (form: HTMLFormElement, name: string): HTMLSelectElement => {
  const field = form.elements.namedItem(name)
  if (!(field instanceof HTMLSelectElement)) throw new Error(`expense select missing: ${name}`)
  return field
}

const formTextarea = (form: HTMLFormElement, name: string): HTMLTextAreaElement => {
  const field = form.elements.namedItem(name)
  if (!(field instanceof HTMLTextAreaElement)) throw new Error(`expense textarea missing: ${name}`)
  return field
}

const textOrNull = (value: string): string | null => {
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

const expensePayload = (
  form: HTMLFormElement,
  categories: readonly ExpenseCategory[],
): ExpenseInput => {
  const projectId = selectedId(form, 'project_id')
  const categoryId = selectedId(form, 'expense_category_id')
  const category = categories.find((candidate) => candidate.id === categoryId)
  if (category === undefined) throw new Error('Choose an available expense category.')
  const spentDate = formInput(form, 'spent_date').value
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(spentDate)) throw new Error('Choose a date.')
  return {
    project_id: projectId,
    expense_category_id: categoryId,
    spent_date: spentDate,
    notes: textOrNull(formTextarea(form, 'notes').value),
    ...expenseValueInput(category, formInput(form, 'expense_value').value),
    billable: formInput(form, 'billable').checked,
    reimbursable: formInput(form, 'reimbursable').checked,
  }
}

const setValuePrompt = (
  category: ExpenseCategory | undefined,
  label: HTMLElement,
  control: HTMLInputElement,
): void => {
  const unitBased = category?.unit_price_cents !== null && category !== undefined
  label.firstChild!.textContent = unitBased
    ? `Units (${category.unit_name ?? 'units'})`
    : 'Amount'
  control.inputMode = unitBased ? 'numeric' : 'decimal'
  control.step = unitBased ? '1' : '0.01'
  control.min = '0'
  control.placeholder = unitBased ? '0' : '0.00'
}

const localDate = (): string => {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.valueOf() - offset).toISOString().slice(0, 10)
}

interface Catalog {
  readonly categories: readonly ExpenseCategory[]
  readonly projects: readonly GeneralResource[]
  readonly clients: readonly GeneralResource[]
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
  readonly generation: number
}

export interface ExpenseWorkflowController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createExpenseWorkflowController = (
  api: Partial<ExpenseWorkflowApi>,
): ExpenseWorkflowController => {
  const listPage = document.documentElement.dataset.appView === 'expense-list'
  const detailPage = document.documentElement.dataset.appView === 'expense-detail'
  const listStatus = required<HTMLElement>('[data-expense-list-status]')
  const list = required<HTMLElement>('[data-expense-list]')
  const loadMore = required<HTMLButtonElement>('[data-expense-load-more]')
  const listRetry = required<HTMLButtonElement>('[data-expense-list-retry]')
  const filterForm = required<HTMLFormElement>('[data-expense-filter-form]')
  const filterReset = required<HTMLButtonElement>('[data-expense-filter-reset]')
  const createPanel = required<HTMLElement>('[data-expense-create-panel]')
  const createForm = required<HTMLFormElement>('[data-expense-create-form]')
  const createSubmit = required<HTMLButtonElement>('[data-expense-create-submit]')
  const createResult = required<HTMLElement>('[data-expense-create-result]')
  const createCategory = required<HTMLSelectElement>('[data-expense-create-category]')
  const createValueLabel = required<HTMLElement>('[data-expense-create-value-label]')
  const detailStatus = required<HTMLElement>('[data-expense-detail-status]')
  const detailArticle = required<HTMLElement>('[data-expense-detail]')
  const detailRetry = required<HTMLButtonElement>('[data-expense-detail-retry]')
  const editForm = required<HTMLFormElement>('[data-expense-edit-form]')
  const editSubmit = required<HTMLButtonElement>('[data-expense-edit-submit]')
  const editResult = required<HTMLElement>('[data-expense-edit-result]')
  const editCategory = required<HTMLSelectElement>('[data-expense-edit-category]')
  const editValueLabel = required<HTMLElement>('[data-expense-edit-value-label]')
  const lockMessage = required<HTMLElement>('[data-expense-lock-message]')
  const attachmentForm = required<HTMLFormElement>('[data-expense-attachment-form]')
  const attachmentSubmit = required<HTMLButtonElement>('[data-expense-attachment-submit]')
  const attachmentStatus = required<HTMLElement>('[data-expense-attachment-status]')
  const attachmentList = required<HTMLUListElement>('[data-expense-attachments]')
  const moduleNotices = [...document.querySelectorAll<HTMLElement>('[data-expense-module-unavailable]')]

  let active: ActiveSession | null = null
  let catalog: Catalog = { categories: [], projects: [], clients: [] }
  let currentExpense: Expense | null = null
  let currentFilters: ExpenseFilters = filtersFromSearch(globalThis.location.search)
  let nextCursor: string | null = null
  let listedExpenses: Expense[] = []
  let weekStartDay: ExpenseWeekStartDay = 'monday'
  let listPending = false
  let mutationPending = false
  let attachmentCommand: string | null = null
  let moduleAvailable = true
  let catalogReady = false
  let removePopstate: (() => void) | null = null
  let activationGeneration = 0
  let catalogRequestGeneration = 0
  let listRequestGeneration = 0
  let detailRequestGeneration = 0

  const current = (): ActiveSession | null =>
    active !== null &&
    active.generation === activationGeneration &&
    !active.signal.aborted
      ? active
      : null

  const apiErrorCode = (error: unknown): string | null => {
    if (!(error instanceof EzactoApiError) || typeof error.body !== 'object' || error.body === null) {
      return null
    }
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail !== 'object' || detail === null) return null
    const code = Reflect.get(detail, 'code')
    return typeof code === 'string' ? code : null
  }

  const fillCatalogSelect = (
    select: HTMLSelectElement,
    values: readonly HTMLOptionElement[],
    emptyLabel?: string,
  ): void => {
    const selected = select.value
    select.replaceChildren(
      ...(emptyLabel === undefined
        ? []
        : [Object.assign(document.createElement('option'), { value: '', textContent: emptyLabel })]),
      ...values,
    )
    if ([...select.options].some((candidate) => candidate.value === selected)) select.value = selected
  }

  const projectOptions = (): HTMLOptionElement[] =>
    catalog.projects.map((project) => option(project.id, expenseProjectLabel(project.id, catalog.projects)))

  const activeProjectOptions = (): HTMLOptionElement[] =>
    catalog.projects
      .filter((project) => project['is_active'] !== false)
      .map((project) => option(project.id, expenseProjectLabel(project.id, catalog.projects)))

  const categoryOptions = (): HTMLOptionElement[] =>
    catalog.categories.map((category) => option(category.id, category.name))

  const activeCategoryOptions = (): HTMLOptionElement[] =>
    catalog.categories
      .filter((category) => category.is_active)
      .map((category) => option(category.id, category.name))

  const clientOptions = (): HTMLOptionElement[] =>
    catalog.clients.map((client) => option(client.id, expenseResourceText(client, 'name') ?? `Client #${client.id}`))

  const populateCatalogs = (): void => {
    fillCatalogSelect(formSelect(createForm, 'project_id'), activeProjectOptions())
    fillCatalogSelect(createCategory, activeCategoryOptions())
    fillCatalogSelect(formSelect(editForm, 'project_id'), projectOptions())
    fillCatalogSelect(editCategory, categoryOptions())
    fillCatalogSelect(formSelect(filterForm, 'client_id'), clientOptions(), 'All clients')
    fillCatalogSelect(formSelect(filterForm, 'project_id'), projectOptions(), 'All projects')
    fillCatalogSelect(formSelect(filterForm, 'expense_category_id'), categoryOptions(), 'All categories')
    setValuePrompt(
      catalog.categories.find((candidate) => candidate.id === Number(createCategory.value)),
      createValueLabel,
      formInput(createForm, 'expense_value'),
    )
  }

  const applyFilterValues = (): void => {
    for (const name of ['from', 'to', 'client_id', 'project_id', 'expense_category_id', 'approval_status', 'reimbursement_status']) {
      const field = filterForm.elements.namedItem(name)
      if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLSelectElement)) continue
      const value = currentFilters[name as keyof ExpenseFilters]
      field.value = value === undefined ? '' : String(value)
    }
  }

  const syncDetailControls = (): void => {
    const hasDetail = current() !== null && moduleAvailable && currentExpense !== null
    const editable =
      hasDetail && currentExpense !== null && expenseIsEditable(currentExpense)
    for (const field of [...editForm.elements]) {
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLButtonElement
      ) field.disabled = !editable || mutationPending
    }
    editSubmit.hidden = currentExpense !== null && !expenseIsEditable(currentExpense)
    for (const field of [...attachmentForm.elements]) {
      if (field instanceof HTMLInputElement) field.disabled = !hasDetail || mutationPending
    }
    attachmentSubmit.disabled = !hasDetail || mutationPending
  }

  const clearPrivatePresentation = (): void => {
    catalogRequestGeneration += 1
    listRequestGeneration += 1
    detailRequestGeneration += 1
    catalog = { categories: [], projects: [], clients: [] }
    currentExpense = null
    currentFilters = filtersFromSearch(globalThis.location.search)
    nextCursor = null
    listedExpenses = []
    weekStartDay = 'monday'
    listPending = false
    mutationPending = false
    attachmentCommand = null
    moduleAvailable = true
    catalogReady = false

    createForm.reset()
    editForm.reset()
    attachmentForm.reset()
    populateCatalogs()
    applyFilterValues()
    formInput(createForm, 'spent_date').value = localDate()
    list.replaceChildren()
    attachmentList.replaceChildren()
    createResult.textContent = ''
    editResult.textContent = ''
    attachmentStatus.textContent = ''
    lockMessage.textContent = ''
    lockMessage.hidden = true
    listStatus.textContent = 'Loading expenses…'
    detailStatus.textContent = 'Loading expense…'
    detailArticle.hidden = true
    listRetry.hidden = true
    detailRetry.hidden = true
    loadMore.hidden = true
    loadMore.disabled = false
    createSubmit.disabled = true
    syncDetailControls()
    for (const selector of [
      '[data-expense-detail-approval]',
      '[data-expense-detail-approval-fact]',
      '[data-expense-detail-reimbursement]',
      '[data-expense-detail-invoice]',
      '[data-expense-detail-total]',
    ]) required<HTMLElement>(selector).textContent = '—'

    createPanel.hidden = false
    filterForm.hidden = false
    list.hidden = false
    for (const notice of moduleNotices) notice.hidden = true
  }

  const showModuleUnavailable = (): void => {
    catalogRequestGeneration += 1
    listRequestGeneration += 1
    detailRequestGeneration += 1
    listPending = false
    mutationPending = false
    moduleAvailable = false
    listedExpenses = []
    nextCursor = null
    currentExpense = null
    list.replaceChildren()
    attachmentList.replaceChildren()
    detailArticle.hidden = true
    createPanel.hidden = true
    filterForm.hidden = true
    list.hidden = true
    loadMore.hidden = true
    listRetry.hidden = true
    detailRetry.hidden = true
    createSubmit.disabled = true
    syncDetailControls()
    const message = 'The expenses module is not enabled for this organization.'
    listStatus.textContent = message
    detailStatus.textContent = message
    for (const notice of moduleNotices) notice.hidden = false
  }

  const sessionFailure = (error: unknown, expected: ActiveSession): boolean => {
    if (
      current() !== expected ||
      !(error instanceof EzactoApiError) ||
      error.status !== 401
    ) return false
    removePopstate?.()
    removePopstate = null
    clearPrivatePresentation()
    active = null
    return expected.onSessionFailure(error)
  }

  const filtersFromForm = (): ExpenseFilters => {
    const data = new FormData(filterForm)
    const from = data.get('from')
    const to = data.get('to')
    if (typeof from === 'string' && typeof to === 'string' && from !== '' && to !== '' && from > to) {
      throw new Error('To date cannot be before From date.')
    }
    const id = (name: string): number | undefined => {
      const raw = data.get(name)
      const value = typeof raw === 'string' ? Number(raw) : Number.NaN
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    }
    const approval = data.get('approval_status')
    const reimbursement = data.get('reimbursement_status')
    const clientId = id('client_id')
    const projectId = id('project_id')
    const categoryId = id('expense_category_id')
    return {
      ...(typeof from === 'string' && from !== '' ? { from } : {}),
      ...(typeof to === 'string' && to !== '' ? { to } : {}),
      ...(clientId === undefined ? {} : { client_id: clientId }),
      ...(projectId === undefined ? {} : { project_id: projectId }),
      ...(categoryId === undefined ? {} : { expense_category_id: categoryId }),
      ...(approval === 'unsubmitted' || approval === 'submitted' || approval === 'approved' ? { approval_status: approval } : {}),
      ...(reimbursement === 'none' || reimbursement === 'pending' || reimbursement === 'approved' || reimbursement === 'paid' ? { reimbursement_status: reimbursement } : {}),
    }
  }

  const updateFilterUrl = (): void => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(currentFilters)) search.set(key, String(value))
    globalThis.history.replaceState(null, '', `/expenses${search.size === 0 ? '' : `?${search.toString()}`}`)
  }

  const expenseBilling = (expense: Expense): string =>
    expense.invoice_id == null
      ? expense.billable
        ? 'Billable · not invoiced'
        : 'Non-billable'
      : `Invoice #${expense.invoice_id}`

  const expenseDateLink = (expense: Expense): HTMLAnchorElement => {
    const link = document.createElement('a')
    link.href = `/expenses/${expense.id}`
    link.textContent = expense.spent_date
    return link
  }

  /**
   * Locked is a state the row wears, not a sentence — `05-expenses-all.png`
   * marks it with a padlock in the row rather than the word. Nothing beside the
   * padlock says it, so this is the icon that carries the whole message and it
   * is named for a reader instead of hidden from one.
   */
  const expenseBillingCell = (expense: Expense): string | DocumentFragment => {
    const billing = [
      expenseBilling(expense),
      expense.reimbursable
        ? `Reimbursement: ${expenseStatusLabel(expense.reimbursement_status)}`
        : 'Not reimbursable',
    ].join(' · ')
    if (!expense.is_locked) return `${billing} · Editable`
    const cell = document.createDocumentFragment()
    cell.append(`${billing} · `, icon('padlock', { label: 'Locked' }))
    return cell
  }

  const expenseStatusPill = (expense: Expense): HTMLSpanElement => {
    const pill = document.createElement('span')
    pill.className = 'expense-status-pill'
    pill.textContent = expenseStatusLabel(expense.approval_status)
    return pill
  }

  const renderList = (): void => {
    const expenses = [...listedExpenses].sort(
      (left, right) =>
        right.spent_date.localeCompare(left.spent_date) || right.id - left.id,
    )
    list.replaceChildren(
      renderDataTable<Expense>({
        caption: 'Expenses by week',
        rows: expenses,
        rowKey: (expense) => String(expense.id),
        // The week is a band over its run of rows, which is how the old list
        // read: one heading, then the days under it.
        groupBy: (expense) => expenseWeekLabel(expense.spent_date, weekStartDay),
        empty: 'No expenses match these filters.',
        columns: [
          { key: 'date', label: 'Date', render: expenseDateLink },
          {
            key: 'work',
            label: 'Client / Project',
            render: (expense) =>
              `${expenseClientLabel(expense.project_id, catalog.projects, catalog.clients)} · ${expenseProjectLabel(expense.project_id, catalog.projects)}`,
          },
          {
            key: 'category',
            label: 'Category',
            render: (expense) =>
              expenseCategoryLabel(expense.expense_category_id, catalog.categories),
          },
          {
            key: 'notes',
            label: 'Notes',
            render: (expense) => expense.notes?.trim() || 'No notes',
          },
          {
            key: 'billing',
            label: 'Billing',
            render: expenseBillingCell,
          },
          { key: 'status', label: 'Status', render: expenseStatusPill },
          {
            key: 'amount',
            label: 'Amount',
            numeric: true,
            render: (expense) =>
              expenseMoney(
                expense.total_cost_cents,
                expenseCurrency(expense.project_id, catalog.projects, catalog.clients),
              ),
            // The old list closes each week with a Total, which is what makes
            // the band a section rather than a label. Rows can span currencies,
            // so a mixed run shows none rather than a wrong sum — the same rule
            // the invoices list follows.
            total: (rows) => {
              const currencies = new Set(
                rows.map((expense) =>
                  expenseCurrency(expense.project_id, catalog.projects, catalog.clients),
                ),
              )
              const [currency] = [...currencies]
              if (currencies.size !== 1 || currency === undefined) return '—'
              return expenseMoney(
                rows.reduce((sum, expense) => sum + expense.total_cost_cents, 0),
                currency,
              )
            },
          },
        ],
      }),
    )
  }

  const loadList = async (append = false): Promise<void> => {
    const session = current()
    if (
      session === null ||
      api.listWorkflowExpenses === undefined ||
      (append && (listPending || nextCursor === null))
    ) return
    const requestGeneration = ++listRequestGeneration
    const filters = { ...currentFilters }
    const cursor = append ? nextCursor ?? undefined : undefined
    if (!append) {
      listedExpenses = []
      nextCursor = null
      renderList()
      loadMore.hidden = true
    }
    listPending = true
    listStatus.textContent = append ? 'Loading more expenses…' : 'Loading expenses…'
    listRetry.hidden = true
    loadMore.disabled = true
    try {
      const page = await api.listWorkflowExpenses(
        filters,
        cursor,
        session.signal,
      )
      if (current() !== session || requestGeneration !== listRequestGeneration) return
      listedExpenses = append ? [...listedExpenses, ...page.data] : [...page.data]
      renderList()
      nextCursor = page.page.next_cursor
      loadMore.hidden = nextCursor === null
      const expenseCount = list.querySelectorAll('tbody tr[data-row]').length
      listStatus.textContent = expenseCount === 0
        ? 'No expenses match these filters.'
        : `${expenseCount} ${expenseCount === 1 ? 'expense' : 'expenses'} shown by week.`
    } catch (error) {
      if (current() !== session || requestGeneration !== listRequestGeneration) return
      if (sessionFailure(error, session)) return
      if (apiErrorCode(error) === 'module_disabled') {
        showModuleUnavailable()
        return
      }
      listStatus.textContent = apiMessage(error)
      listRetry.hidden = false
    } finally {
      if (current() === session && requestGeneration === listRequestGeneration) {
        listPending = false
        loadMore.disabled = false
      }
    }
  }

  const renderAttachments = (expenseId: number, attachments: readonly Attachment[]): void => {
    attachmentList.replaceChildren()
    if (attachments.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'expense-attachment-empty'
      empty.textContent = 'No receipts attached.'
      attachmentList.append(empty)
      return
    }
    for (const attachment of attachments) {
      const row = document.createElement('li')
      const link = document.createElement('a')
      link.href = `/api/v1/expenses/${expenseId}/attachments/${attachment.id}/content`
      link.textContent = attachment.name
      // The clip belongs to the file name, so it goes inside the link rather
      // than beside it — and the name is already the label, so it is hidden
      // from the reader rather than announced a second time.
      link.prepend(icon('paperclip'))
      link.setAttribute('download', attachment.name)
      const metadata = document.createElement('span')
      metadata.textContent = `${new Intl.NumberFormat('en-US').format(attachment.byte_size)} bytes`
      row.append(link, metadata)
      attachmentList.append(row)
    }
  }

  const renderDetail = (expense: Expense): void => {
    currentExpense = expense
    const category = catalog.categories.find((candidate) => candidate.id === expense.expense_category_id)
    const project = catalog.projects.find((candidate) => candidate.id === expense.project_id)
    if (category !== undefined && ![...editCategory.options].some((item) => item.value === String(category.id))) {
      editCategory.append(option(category.id, category.name))
    }
    if (project !== undefined && ![...formSelect(editForm, 'project_id').options].some((item) => item.value === String(project.id))) {
      formSelect(editForm, 'project_id').append(option(project.id, expenseProjectLabel(project.id, catalog.projects)))
    }
    formSelect(editForm, 'project_id').value = String(expense.project_id)
    editCategory.value = String(expense.expense_category_id)
    formInput(editForm, 'spent_date').value = expense.spent_date
    formTextarea(editForm, 'notes').value = expense.notes ?? ''
    formInput(editForm, 'billable').checked = expense.billable
    formInput(editForm, 'reimbursable').checked = expense.reimbursable
    if (category !== undefined) formInput(editForm, 'expense_value').value = expenseValueForForm(expense, category)
    setValuePrompt(category, editValueLabel, formInput(editForm, 'expense_value'))
    required<HTMLElement>('[data-expense-detail-approval]').textContent = expenseStatusLabel(expense.approval_status)
    required<HTMLElement>('[data-expense-detail-approval-fact]').textContent = expenseStatusLabel(expense.approval_status)
    required<HTMLElement>('[data-expense-detail-reimbursement]').textContent = expense.reimbursable
      ? expenseStatusLabel(expense.reimbursement_status)
      : 'Not reimbursable'
    required<HTMLElement>('[data-expense-detail-invoice]').textContent = expense.invoice_id == null ? 'Not invoiced' : `Invoice #${expense.invoice_id}`
    required<HTMLElement>('[data-expense-detail-total]').textContent = expenseMoney(
      expense.total_cost_cents,
      expenseCurrency(expense.project_id, catalog.projects, catalog.clients),
    )
    const reason = expenseLockExplanation(expense)
    lockMessage.hidden = reason === null
    lockMessage.textContent = reason ?? ''
    const editable = expenseIsEditable(expense)
    editResult.textContent = editable && expense.approval_status === 'submitted'
      ? 'Submitted expenses remain editable until approval or another lock applies.'
      : ''
    syncDetailControls()
    detailArticle.hidden = false
    detailStatus.textContent = ''
  }

  const loadDetail = async (): Promise<void> => {
    const session = current()
    const expenseId = expenseIdFromPathname(globalThis.location.pathname)
    if (
      session === null ||
      expenseId === null ||
      api.getWorkflowExpense === undefined ||
      api.listWorkflowExpenseAttachments === undefined
    ) return
    const requestGeneration = ++detailRequestGeneration
    detailStatus.textContent = 'Loading expense…'
    detailArticle.hidden = true
    detailRetry.hidden = true
    try {
      const [expense, attachments] = await Promise.all([
        api.getWorkflowExpense(expenseId, session.signal),
        api.listWorkflowExpenseAttachments(expenseId, session.signal),
      ])
      if (current() !== session || requestGeneration !== detailRequestGeneration) return
      renderDetail(expense)
      renderAttachments(expense.id, attachments)
      attachmentStatus.textContent = attachments.length === 0 ? '' : `${attachments.length} receipt ${attachments.length === 1 ? 'file' : 'files'}.`
    } catch (error) {
      if (current() !== session || requestGeneration !== detailRequestGeneration) return
      if (sessionFailure(error, session)) return
      if (apiErrorCode(error) === 'module_disabled') {
        showModuleUnavailable()
        return
      }
      detailStatus.textContent = apiMessage(error)
      detailArticle.hidden = true
      detailRetry.hidden = false
    }
  }

  const loadCatalog = async (
    session: ActiveSession,
    requestGeneration: number,
  ): Promise<boolean> => {
    if (
      api.listExpenseCategories === undefined ||
      api.listExpenseProjects === undefined ||
      api.listExpenseClients === undefined ||
      api.getExpenseWeekStartDay === undefined
    ) throw new Error('Expense catalogs are unavailable.')
    const [categories, projects, clients, configuredWeekStart] = await Promise.all([
      collect((cursor) => api.listExpenseCategories!(cursor, session.signal), session.signal),
      collect((cursor) => api.listExpenseProjects!(cursor, session.signal), session.signal),
      collect((cursor) => api.listExpenseClients!(cursor, session.signal), session.signal),
      api.getExpenseWeekStartDay(session.signal),
    ])
    if (
      current() !== session ||
      requestGeneration !== catalogRequestGeneration
    ) return false
    catalog = { categories, projects, clients }
    catalogReady = true
    weekStartDay = configuredWeekStart
    populateCatalogs()
    applyFilterValues()
    createSubmit.disabled =
      categories.every((item) => !item.is_active) ||
      projects.every((item) => item['is_active'] === false)
    return true
  }

  const reloadWorkflow = async (): Promise<void> => {
    const session = current()
    if (session === null) return
    const requestGeneration = ++catalogRequestGeneration
    if (listPage) {
      listStatus.textContent = 'Loading expenses…'
      listRetry.hidden = true
    }
    if (detailPage) {
      detailStatus.textContent = 'Loading expense…'
      detailRetry.hidden = true
    }
    try {
      if (
        !(await loadCatalog(session, requestGeneration)) ||
        current() !== session ||
        requestGeneration !== catalogRequestGeneration
      ) return
      if (listPage) await loadList()
      if (detailPage) await loadDetail()
    } catch (error) {
      if (
        current() !== session ||
        requestGeneration !== catalogRequestGeneration
      ) return
      if (sessionFailure(error, session)) return
      if (apiErrorCode(error) === 'module_disabled') {
        showModuleUnavailable()
        return
      }
      const status = listPage ? listStatus : detailStatus
      status.textContent = apiMessage(error)
      if (listPage) listRetry.hidden = false
      if (detailPage) detailRetry.hidden = false
    }
  }

  createCategory.addEventListener('change', () => {
    formInput(createForm, 'expense_value').value = ''
    setValuePrompt(
      catalog.categories.find((candidate) => candidate.id === Number(createCategory.value)),
      createValueLabel,
      formInput(createForm, 'expense_value'),
    )
  })

  editCategory.addEventListener('change', () => {
    formInput(editForm, 'expense_value').value = ''
    setValuePrompt(
      catalog.categories.find((candidate) => candidate.id === Number(editCategory.value)),
      editValueLabel,
      formInput(editForm, 'expense_value'),
    )
  })

  createForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    if (session === null || mutationPending || api.createWorkflowExpense === undefined) return
    let payload: ExpenseInput
    try {
      payload = expensePayload(createForm, catalog.categories)
    } catch (error) {
      createResult.textContent = apiMessage(error)
      return
    }
    mutationPending = true
    createSubmit.disabled = true
    createResult.textContent = 'Adding expense…'
    api.createWorkflowExpense(payload, session.signal).then((expense) => {
      if (current() !== session) return
      createForm.reset()
      formInput(createForm, 'spent_date').value = localDate()
      populateCatalogs()
      createResult.textContent = `Expense added. Open expense #${expense.id} to attach a receipt.`
      void loadList()
    }).catch((error: unknown) => {
      if (current() !== session) return
      if (sessionFailure(error, session)) return
      if (apiErrorCode(error) === 'module_disabled') showModuleUnavailable()
      else createResult.textContent = apiMessage(error)
    }).finally(() => {
      if (current() === session && moduleAvailable) {
        mutationPending = false
        createSubmit.disabled = false
      }
    })
  })

  editForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    if (
      session === null ||
      mutationPending ||
      currentExpense === null ||
      api.updateWorkflowExpense === undefined
    ) return
    let payload: ExpensePatch
    try {
      payload = expensePatch(
        currentExpense,
        expensePayload(editForm, catalog.categories),
      )
    } catch (error) {
      editResult.textContent = apiMessage(error)
      return
    }
    if (Object.keys(payload).length === 0) {
      editResult.textContent = 'No changes to save.'
      return
    }
    mutationPending = true
    syncDetailControls()
    editResult.textContent = 'Saving expense…'
    api.updateWorkflowExpense(currentExpense.id, payload, session.signal).then((expense) => {
      if (current() !== session) return
      renderDetail(expense)
      editResult.textContent = 'Expense saved.'
    }).catch((error: unknown) => {
      if (current() !== session) return
      if (sessionFailure(error, session)) return
      if (apiErrorCode(error) === 'module_disabled') showModuleUnavailable()
      else editResult.textContent = apiMessage(error)
    }).finally(() => {
      if (current() === session && moduleAvailable) {
        mutationPending = false
        syncDetailControls()
      }
    })
  })

  attachmentForm.addEventListener('input', () => {
    if (!mutationPending) attachmentCommand = null
  })

  attachmentForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    if (
      session === null ||
      currentExpense === null ||
      mutationPending ||
      api.uploadWorkflowExpenseAttachment === undefined ||
      api.listWorkflowExpenseAttachments === undefined
    ) return
    const fileControl = formInput(attachmentForm, 'file')
    const file = fileControl.files?.[0]
    if (file === undefined || file.size === 0) {
      attachmentStatus.textContent = 'Choose a non-empty receipt file.'
      return
    }
    const data = new FormData()
    data.set('file', file)
    mutationPending = true
    syncDetailControls()
    attachmentCommand ??= `web.expense.attachment:${crypto.randomUUID()}`
    const command = attachmentCommand
    const expenseId = currentExpense.id
    attachmentStatus.textContent = 'Uploading receipt…'
    api.uploadWorkflowExpenseAttachment(expenseId, command, data, session.signal).then(async () => {
      if (current() !== session) return
      const attachments = await api.listWorkflowExpenseAttachments!(expenseId, session.signal)
      if (current() !== session) return
      attachmentCommand = null
      attachmentForm.reset()
      renderAttachments(expenseId, attachments)
      attachmentStatus.textContent = 'Receipt uploaded.'
    }).catch((error: unknown) => {
      if (current() !== session) return
      if (sessionFailure(error, session)) return
      if (apiErrorCode(error) === 'module_disabled') showModuleUnavailable()
      else attachmentStatus.textContent = apiMessage(error)
    }).finally(() => {
      if (current() === session && moduleAvailable) {
        mutationPending = false
        syncDetailControls()
      }
    })
  })

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault()
    try {
      currentFilters = filtersFromForm()
      updateFilterUrl()
      void loadList()
    } catch (error) {
      listStatus.textContent = apiMessage(error)
    }
  })

  filterReset.addEventListener('click', () => {
    currentFilters = {}
    filterForm.reset()
    updateFilterUrl()
    void loadList()
  })

  formSelect(filterForm, 'client_id').addEventListener('change', () => {
    const clientId = Number(formSelect(filterForm, 'client_id').value)
    const project = formSelect(filterForm, 'project_id')
    const selected = project.value
    const projects = Number.isSafeInteger(clientId) && clientId > 0
      ? catalog.projects.filter((candidate) => expenseResourceNumber(candidate, 'client_id') === clientId)
      : catalog.projects
    fillCatalogSelect(
      project,
      projects.map((candidate) => option(candidate.id, expenseProjectLabel(candidate.id, catalog.projects))),
      'All projects',
    )
    if ([...project.options].some((candidate) => candidate.value === selected)) project.value = selected
  })

  loadMore.addEventListener('click', () => void loadList(true))
  listRetry.addEventListener('click', () => void reloadWorkflow())
  detailRetry.addEventListener('click', () => void reloadWorkflow())

  return {
    async activate(identity, signal, onSessionFailure) {
      removePopstate?.()
      removePopstate = null
      const session: ActiveSession = {
        identity,
        signal,
        onSessionFailure,
        generation: ++activationGeneration,
      }
      active = session
      clearPrivatePresentation()
      const onPopstate = (): void => {
        if (!listPage || current() !== session) return
        currentFilters = filtersFromSearch(globalThis.location.search)
        applyFilterValues()
        if (catalogReady) void loadList()
        else void reloadWorkflow()
      }
      const removeSessionPopstate = (): void => {
        globalThis.removeEventListener('popstate', onPopstate)
      }
      if (listPage) {
        globalThis.addEventListener('popstate', onPopstate)
        removePopstate = removeSessionPopstate
      }
      const abort = (): void => {
        if (active !== session) return
        if (removePopstate === removeSessionPopstate) {
          removeSessionPopstate()
          removePopstate = null
        }
        active = null
        clearPrivatePresentation()
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      await reloadWorkflow()
    },
  }
}
