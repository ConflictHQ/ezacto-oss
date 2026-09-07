import type { ApprovalStatus } from '@ezacto/core'
import type { Hono } from 'hono'
import { canReviewSubmissions } from '@ezacto/core'
import { requireApiScope } from '../auth.js'
import type { ApiContext, UserPrincipal } from '../context.js'
import { ApiError, type FieldError } from '../errors.js'
import { cursorPage } from '../pagination.js'
import { serializeOne } from '../serializer.js'
import {
  assertFields,
  optionalBoolean,
  optionalDate,
  optionalNonnegativeInteger,
  optionalNullableString,
  optionalPositiveInteger,
  queryBoolean,
  queryDate,
  queryEnum,
  queryPositiveInteger,
  queryTimestamp,
  readObjectBody,
  requiredPositiveInteger,
  resourceId,
  strictSearchParams,
  translateResourceError,
  unknownFieldErrors,
} from './support.js'
import type {
  CreateExpenseRequest,
  ExpenseFilters,
  ExpenseRecord,
  ReimbursementStatus,
  TrackedResourceClock,
  TrackedResourceRepository,
  UpdateExpenseRequest,
} from './tracked-repository.js'

export interface ExpenseRouteOptions {
  repository: TrackedResourceRepository
  clock: TrackedResourceClock
  cursorSigningKey: Uint8Array
  isExpensesModuleEnabled(): Promise<boolean>
}

interface ExpenseOutput {
  id: number
  user_id: number
  project_id: number
  expense_category_id: number
  spent_date: string
  notes: string | null
  units: number | null
  total_cost_cents: number
  billable: boolean
  approval_status: ApprovalStatus
  invoice_id: number | null
  is_billed: boolean
  is_locked: boolean
  locked_reason_code: string | null
  locked_reason: string | null
  reimbursable: boolean
  reimbursement_status: ReimbursementStatus
  payout_ref: string | null
  created_at: string
  updated_at: string
}

export const serializeExpense = (
  expense: Readonly<ExpenseRecord>,
  viewer: Readonly<UserPrincipal>,
): ExpenseOutput => {
  void viewer
  return {
    id: expense.id,
    user_id: expense.userId,
    project_id: expense.projectId,
    expense_category_id: expense.expenseCategoryId,
    spent_date: expense.spentDate,
    notes: expense.notes,
    units: expense.units,
    total_cost_cents: expense.totalCostCents,
    billable: expense.billable,
    approval_status: expense.state.approvalStatus,
    invoice_id: expense.state.invoiceId,
    is_billed: expense.state.isBilled,
    is_locked: expense.state.isLocked,
    locked_reason_code: expense.state.lockedReasonCode,
    locked_reason: expense.state.lockedReason,
    reimbursable: expense.reimbursable,
    reimbursement_status: expense.reimbursementStatus,
    payout_ref: expense.payoutRef,
    created_at: expense.createdAt,
    updated_at: expense.updatedAt,
  }
}

const listKeys = new Set([
  'cursor',
  'per_page',
  'user_id',
  'client_id',
  'project_id',
  'expense_category_id',
  'spent_date',
  'from',
  'to',
  'approval_status',
  'invoice_id',
  'is_billed',
  'billable',
  'reimbursable',
  'reimbursement_status',
  'updated_since',
])

const expenseFilters = (
  url: URL,
  principal: Readonly<UserPrincipal>,
): { readonly filters: ExpenseFilters; readonly userId: number } => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const userId = queryPositiveInteger(params, 'user_id', errors)
  const clientId = queryPositiveInteger(params, 'client_id', errors)
  const projectId = queryPositiveInteger(params, 'project_id', errors)
  const expenseCategoryId = queryPositiveInteger(
    params,
    'expense_category_id',
    errors,
  )
  const invoiceId = queryPositiveInteger(params, 'invoice_id', errors)
  const spentDate = queryDate(params, 'spent_date', errors)
  const from = queryDate(params, 'from', errors)
  const to = queryDate(params, 'to', errors)
  const approvalStatus = queryEnum(
    params,
    'approval_status',
    ['unsubmitted', 'submitted', 'approved'] as const,
    errors,
  )
  const isBilled = queryBoolean(params, 'is_billed', errors)
  const billable = queryBoolean(params, 'billable', errors)
  const reimbursable = queryBoolean(params, 'reimbursable', errors)
  const reimbursementStatus = queryEnum(
    params,
    'reimbursement_status',
    ['none', 'pending', 'approved', 'paid'] as const,
    errors,
  )
  const updatedSince = queryTimestamp(params, 'updated_since', errors)
  if (from !== undefined && to !== undefined && from > to) {
    errors.push({
      field: 'to',
      code: 'invalid_range',
      message: 'to must not precede from',
    })
  }
  if (invoiceId !== undefined && isBilled === false) {
    errors.push({
      field: 'is_billed',
      code: 'filter_conflict',
      message: 'is_billed=false cannot be combined with invoice_id',
    })
  }
  assertFields(errors)
  // Someone else's expenses are visible to the people who review submitted work
  // -- the same authority that approves a timesheet, answered in one place so
  // the two cannot drift. Everyone else sees their own.
  if (
    userId !== undefined &&
    userId !== principal.userId &&
    !canReviewSubmissions(principal.profile)
  ) {
    throw new ApiError({
      status: 403,
      code: 'row_forbidden',
      message: 'Expenses are limited to the acting user unless you review submissions.',
    })
  }
  return {
    // Whose expenses to read. A reviewer has to name the person: omitting
    // user_id still means "mine", so widening the profile does not quietly turn
    // the unscoped list into everyone's.
    userId: userId ?? principal.userId,
    filters: {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(expenseCategoryId !== undefined ? { expenseCategoryId } : {}),
    ...(spentDate !== undefined ? { spentDate } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(approvalStatus !== undefined ? { approvalStatus } : {}),
    ...(invoiceId !== undefined ? { invoiceId } : {}),
    ...(isBilled !== undefined ? { isBilled } : {}),
    ...(billable !== undefined ? { billable } : {}),
    ...(reimbursable !== undefined ? { reimbursable } : {}),
    ...(reimbursementStatus !== undefined ? { reimbursementStatus } : {}),
    ...(updatedSince !== undefined ? { updatedSince } : {}),
    },
  }
}

const bodyKeys = new Set([
  'project_id',
  'expense_category_id',
  'spent_date',
  'notes',
  'units',
  'total_cost_cents',
  'billable',
  'reimbursable',
])

const readCreateInput = (
  body: Record<string, unknown>,
): CreateExpenseRequest => {
  const errors = unknownFieldErrors(body, bodyKeys)
  const projectId = requiredPositiveInteger(body, 'project_id', errors)
  const expenseCategoryId = requiredPositiveInteger(
    body,
    'expense_category_id',
    errors,
  )
  const spentDate = optionalDate(body, 'spent_date', errors)
  if (!Object.hasOwn(body, 'spent_date')) {
    errors.push({
      field: 'spent_date',
      code: 'required',
      message: 'spent_date is required',
    })
  }
  const notes = optionalNullableString(body, 'notes', errors)
  const units = optionalNonnegativeInteger(body, 'units', errors)
  const totalCostCents = optionalNonnegativeInteger(
    body,
    'total_cost_cents',
    errors,
    9_000_000_000_000,
  )
  const billable = optionalBoolean(body, 'billable', errors)
  const reimbursable = optionalBoolean(body, 'reimbursable', errors)
  const hasUnits = Object.hasOwn(body, 'units')
  const hasTotal = Object.hasOwn(body, 'total_cost_cents')
  if (hasUnits === hasTotal) {
    errors.push({
      field: 'units',
      code: 'exactly_one',
      message: 'send exactly one of units or total_cost_cents',
    })
  }
  assertFields(errors)
  return {
    projectId: projectId!,
    expenseCategoryId: expenseCategoryId!,
    spentDate: spentDate!,
    ...(notes !== undefined ? { notes } : {}),
    ...(units !== undefined ? { units } : {}),
    ...(totalCostCents !== undefined ? { totalCostCents } : {}),
    ...(billable !== undefined ? { billable } : {}),
    ...(reimbursable !== undefined ? { reimbursable } : {}),
  }
}

const readUpdateInput = (
  body: Record<string, unknown>,
): UpdateExpenseRequest => {
  const errors = unknownFieldErrors(body, bodyKeys)
  if (!Object.keys(body).some((key) => bodyKeys.has(key))) {
    errors.push({
      field: 'body',
      code: 'empty',
      message: 'at least one writable field is required',
    })
  }
  const projectId = optionalPositiveInteger(body, 'project_id', errors)
  const expenseCategoryId = optionalPositiveInteger(
    body,
    'expense_category_id',
    errors,
  )
  const spentDate = optionalDate(body, 'spent_date', errors)
  const notes = optionalNullableString(body, 'notes', errors)
  const units = optionalNonnegativeInteger(body, 'units', errors)
  const totalCostCents = optionalNonnegativeInteger(
    body,
    'total_cost_cents',
    errors,
    9_000_000_000_000,
  )
  const billable = optionalBoolean(body, 'billable', errors)
  const reimbursable = optionalBoolean(body, 'reimbursable', errors)
  if (Object.hasOwn(body, 'units') && Object.hasOwn(body, 'total_cost_cents')) {
    errors.push({
      field: 'units',
      code: 'mutually_exclusive',
      message: 'send units or total_cost_cents, not both',
    })
  }
  assertFields(errors)
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(expenseCategoryId !== undefined ? { expenseCategoryId } : {}),
    ...(spentDate !== undefined ? { spentDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(units !== undefined ? { units } : {}),
    ...(totalCostCents !== undefined ? { totalCostCents } : {}),
    ...(billable !== undefined ? { billable } : {}),
    ...(reimbursable !== undefined ? { reimbursable } : {}),
  }
}

const selfLink = (id: number) => `/api/v1/expenses/${id}`

const requireExpensesModule = async (options: ExpenseRouteOptions): Promise<void> => {
  if (await options.isExpensesModuleEnabled()) return
  throw new ApiError({
    status: 403,
    code: 'module_disabled',
    message: 'The expenses module is not enabled for this organization.',
  })
}

export const installExpenseRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ExpenseRouteOptions,
): void => {
  api.get('/expenses', async (context) => {
    requireApiScope(context, 'expenses:read')
    const principal = context.get('principal')
    try {
      await requireExpensesModule(options)
      const url = new URL(context.req.url)
      const scope = expenseFilters(url, principal)
      const envelope = await cursorPage({
        requestUrl: url,
        source: options.repository.expenses(scope.userId, scope.filters),
        viewer: principal,
        serializer: serializeExpense,
        cursorSigningKey: options.cursorSigningKey,
      })
      return context.json(envelope, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translateResourceError(error, 'expense')
    }
  })

  api.post('/expenses', async (context) => {
    requireApiScope(context, 'expenses:write')
    const principal = context.get('principal')
    try {
      await requireExpensesModule(options)
      const expense = await options.repository.createExpense(
        principal.userId,
        readCreateInput(await readObjectBody(context)),
        options.clock.now(),
      )
      return context.json(
        {
          data: serializeOne(expense, principal, serializeExpense),
          links: { self: selfLink(expense.id) },
        },
        201,
        { 'cache-control': 'no-store', location: selfLink(expense.id) },
      )
    } catch (error) {
      return translateResourceError(error, 'expense')
    }
  })

  api.get('/expenses/:id', async (context) => {
    requireApiScope(context, 'expenses:read')
    const principal = context.get('principal')
    try {
      await requireExpensesModule(options)
      const expense = await options.repository.getExpense(
        principal.userId,
        resourceId(context.req.param('id'), 'expense'),
      )
      return context.json(
        {
          data: serializeOne(expense, principal, serializeExpense),
          links: { self: selfLink(expense.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'expense')
    }
  })

  api.patch('/expenses/:id', async (context) => {
    requireApiScope(context, 'expenses:write')
    const principal = context.get('principal')
    try {
      await requireExpensesModule(options)
      const expense = await options.repository.updateExpense(
        principal.userId,
        resourceId(context.req.param('id'), 'expense'),
        readUpdateInput(await readObjectBody(context)),
        options.clock.now(),
      )
      return context.json(
        {
          data: serializeOne(expense, principal, serializeExpense),
          links: { self: selfLink(expense.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'expense')
    }
  })

  api.delete('/expenses/:id', async (context) => {
    requireApiScope(context, 'expenses:write')
    const principal = context.get('principal')
    try {
      await requireExpensesModule(options)
      const expense = await options.repository.deleteExpense(
        principal.userId,
        resourceId(context.req.param('id'), 'expense'),
      )
      return context.json(
        {
          data: serializeOne(expense, principal, serializeExpense),
          links: { self: selfLink(expense.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'expense')
    }
  })
}
