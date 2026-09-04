import type {
  Attachment,
  Expense,
  ExpenseCategory,
  ExpenseInput,
  ExpensePatch,
  GeneralResource,
} from '@ezacto/client'

export type ExpenseApprovalStatus = Expense['approval_status']
export type ExpenseReimbursementStatus = Expense['reimbursement_status']
export type ExpenseWeekStartDay = 'saturday' | 'sunday' | 'monday'

export interface ExpenseFilters {
  readonly from?: string
  readonly to?: string
  readonly client_id?: number
  readonly project_id?: number
  readonly expense_category_id?: number
  readonly approval_status?: ExpenseApprovalStatus
  readonly reimbursement_status?: ExpenseReimbursementStatus
}

export interface ExpensePage<T> {
  readonly data: readonly T[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ExpenseWorkflowApi {
  getExpenseWeekStartDay(signal?: AbortSignal): Promise<ExpenseWeekStartDay>
  listWorkflowExpenses(
    filters: ExpenseFilters,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ExpensePage<Expense>>
  getWorkflowExpense(id: number, signal?: AbortSignal): Promise<Expense>
  createWorkflowExpense(input: ExpenseInput, signal?: AbortSignal): Promise<Expense>
  updateWorkflowExpense(
    id: number,
    input: ExpensePatch,
    signal?: AbortSignal,
  ): Promise<Expense>
  listExpenseCategories(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ExpensePage<ExpenseCategory>>
  listExpenseProjects(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ExpensePage<GeneralResource>>
  listExpenseClients(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ExpensePage<GeneralResource>>
  listWorkflowExpenseAttachments(
    expenseId: number,
    signal?: AbortSignal,
  ): Promise<readonly Attachment[]>
  uploadWorkflowExpenseAttachment(
    expenseId: number,
    commandId: string,
    body: FormData,
    signal?: AbortSignal,
  ): Promise<Attachment>
}

export const expenseIdFromPathname = (pathname: string): number | null => {
  const match = /^\/expenses\/([1-9][0-9]*)\/?$/u.exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export const expenseResourceText = (
  resource: Readonly<GeneralResource> | undefined,
  field: string,
): string | null => {
  const value = resource?.[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export const expenseResourceNumber = (
  resource: Readonly<GeneralResource> | undefined,
  field: string,
): number | null => {
  const value = resource?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const expenseProjectLabel = (
  projectId: number,
  projects: readonly GeneralResource[],
): string => {
  const project = projects.find((candidate) => candidate.id === projectId)
  const name = expenseResourceText(project, 'name') ?? `Project #${projectId}`
  const code = expenseResourceText(project, 'code')
  return code === null ? name : `[${code}] ${name}`
}

export const expenseClientLabel = (
  projectId: number,
  projects: readonly GeneralResource[],
  clients: readonly GeneralResource[],
): string => {
  const project = projects.find((candidate) => candidate.id === projectId)
  const clientId = expenseResourceNumber(project, 'client_id')
  if (clientId === null) return 'Unknown client'
  const client = clients.find((candidate) => candidate.id === clientId)
  return expenseResourceText(client, 'name') ?? `Client #${clientId}`
}

export const expenseCategoryLabel = (
  categoryId: number,
  categories: readonly ExpenseCategory[],
): string =>
  categories.find((candidate) => candidate.id === categoryId)?.name ??
  `Category #${categoryId}`

export const expenseCurrency = (
  projectId: number,
  projects: readonly GeneralResource[],
  clients: readonly GeneralResource[],
): string => {
  const project = projects.find((candidate) => candidate.id === projectId)
  const projectCurrency = expenseResourceText(project, 'billing_currency')
  if (projectCurrency !== null) return projectCurrency
  const clientId = expenseResourceNumber(project, 'client_id')
  const client = clients.find((candidate) => candidate.id === clientId)
  return expenseResourceText(client, 'currency') ?? 'USD'
}

export const expenseMoney = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
  }
}

export const expenseStatusLabel = (value: string): string =>
  value
    .split('_')
    .map((part) => part[0]!.toLocaleUpperCase('en-US') + part.slice(1))
    .join(' ')

export const expenseWeekStart = (
  spentDate: string,
  weekStartDay: ExpenseWeekStartDay = 'monday',
): string => {
  const date = new Date(`${spentDate}T00:00:00.000Z`)
  const startIndex = weekStartDay === 'saturday' ? 6 : weekStartDay === 'sunday' ? 0 : 1
  const offset = (date.getUTCDay() - startIndex + 7) % 7
  date.setUTCDate(date.getUTCDate() - offset)
  return date.toISOString().slice(0, 10)
}

export const expenseWeekLabel = (
  spentDate: string,
  weekStartDay: ExpenseWeekStartDay = 'monday',
): string => {
  const start = expenseWeekStart(spentDate, weekStartDay)
  const endDate = new Date(`${start}T00:00:00.000Z`)
  endDate.setUTCDate(endDate.getUTCDate() + 6)
  const format = (value: Date): string =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
      year: 'numeric',
    }).format(value)
  return `Week of ${format(new Date(`${start}T00:00:00.000Z`))} – ${format(endDate)}`
}

export const expenseIsEditable = (expense: Readonly<Expense>): boolean =>
  expense.approval_status !== 'approved' &&
  (expense.invoice_id === null || expense.invoice_id === undefined) &&
  !expense.is_billed &&
  !expense.is_locked

export const expenseLockExplanation = (expense: Readonly<Expense>): string | null => {
  if (expense.locked_reason !== null && expense.locked_reason !== undefined) {
    return expense.locked_reason
  }
  if (expense.is_billed || (expense.invoice_id !== null && expense.invoice_id !== undefined)) {
    return 'This expense has been invoiced and cannot be changed.'
  }
  if (expense.approval_status === 'approved') {
    return 'This expense is approved and cannot be changed until its timesheet is reopened.'
  }
  if (expense.is_locked) return 'This expense is locked by policy.'
  return null
}

const moneyPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u

export const expenseAmountCents = (raw: string): number => {
  const value = raw.trim()
  if (!moneyPattern.test(value)) {
    throw new Error('Amount must be zero or greater with no more than two decimals.')
  }
  const [whole, fraction = ''] = value.split('.')
  const cents = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')))
  if (!Number.isSafeInteger(cents) || cents > 9_000_000_000_000) {
    throw new Error('Amount is too large.')
  }
  return cents
}

export const expenseUnits = (raw: string): number => {
  const value = Number(raw)
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new Error('Units must be a whole number that is zero or greater.')
  }
  return value
}

export const expenseValueInput = (
  category: Readonly<ExpenseCategory>,
  raw: string,
): Pick<ExpenseInput, 'units' | 'total_cost_cents'> =>
  category.unit_price_cents === null
    ? { total_cost_cents: expenseAmountCents(raw) }
    : { units: expenseUnits(raw) }

export const expenseValueForForm = (
  expense: Readonly<Expense>,
  category: Readonly<ExpenseCategory>,
): string =>
  category.unit_price_cents === null
    ? String(expense.total_cost_cents / 100)
    : String(expense.units ?? 0)

/**
 * Build a semantic PATCH instead of replaying the create payload. In
 * particular, a notes-only edit must not ask the repository to reprice an
 * existing unit-based expense against today's category price.
 */
export const expensePatch = (
  expense: Readonly<Expense>,
  desired: Readonly<ExpenseInput>,
): ExpensePatch => {
  const patch: ExpensePatch = {}
  if (desired.project_id !== expense.project_id) patch.project_id = desired.project_id
  if (desired.expense_category_id !== expense.expense_category_id) {
    patch.expense_category_id = desired.expense_category_id
  }
  if (desired.spent_date !== expense.spent_date) patch.spent_date = desired.spent_date
  if (desired.notes !== undefined && desired.notes !== expense.notes) patch.notes = desired.notes
  if (desired.billable !== undefined && desired.billable !== expense.billable) {
    patch.billable = desired.billable
  }
  if (desired.reimbursable !== undefined && desired.reimbursable !== expense.reimbursable) {
    patch.reimbursable = desired.reimbursable
  }

  const categoryChanged = desired.expense_category_id !== expense.expense_category_id
  if (desired.units !== undefined) {
    if (categoryChanged || desired.units !== expense.units) patch.units = desired.units
  } else if (
    desired.total_cost_cents !== undefined &&
    (categoryChanged || desired.total_cost_cents !== expense.total_cost_cents)
  ) {
    patch.total_cost_cents = desired.total_cost_cents
  }
  return patch
}

export const filtersFromSearch = (search: string): ExpenseFilters => {
  const params = new URLSearchParams(search)
  const date = (name: string): string | undefined => {
    const value = params.get(name)
    return value !== null && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined
  }
  const id = (name: string): number | undefined => {
    const value = Number(params.get(name))
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  const approval = params.get('approval_status')
  const reimbursement = params.get('reimbursement_status')
  const from = date('from')
  const to = date('to')
  const clientId = id('client_id')
  const projectId = id('project_id')
  const categoryId = id('expense_category_id')
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(clientId === undefined ? {} : { client_id: clientId }),
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(categoryId === undefined ? {} : { expense_category_id: categoryId }),
    ...(approval === 'unsubmitted' || approval === 'submitted' || approval === 'approved'
      ? { approval_status: approval }
      : {}),
    ...(reimbursement === 'none' || reimbursement === 'pending' || reimbursement === 'approved' || reimbursement === 'paid'
      ? { reimbursement_status: reimbursement }
      : {}),
  }
}
