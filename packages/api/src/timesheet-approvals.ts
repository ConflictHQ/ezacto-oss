import type { Hono } from 'hono'
import { canReviewSubmissions, maximumBulkApprovalSelections } from '@ezacto/core'
import { requireApiScope } from './auth.js'
import type { ApiContext, UserPrincipal, UserProfile } from './context.js'
import { ApiError, validationError, type FieldError } from './errors.js'
import { cursorPage, type CursorSource } from './pagination.js'
import {
  assertFields,
  isCanonicalDate,
  isJsonObject,
  queryDate,
  queryPositiveInteger,
  readObjectBody,
  resourceId,
  strictSearchParams,
  unknownFieldErrors,
} from './resources/support.js'

export type TimesheetSubmissionStatus = 'unsubmitted' | 'submitted' | 'approved'

export interface TimesheetSubmissionRecord {
  id: number
  userId: number
  userName: string
  periodStart: string
  periodEnd: string
  status: TimesheetSubmissionStatus
  origin: 'native' | 'harvest_import' | 'legacy_backfill'
  sourceStatus: 'submitted' | 'approved' | null
  sourceObservedAt: string | null
  submittedByUserId: number | null
  submittedAt: string | null
  reviewedByUserId: number | null
  reviewedAt: string | null
  rejectionReason: string | null
  version: number
  entryCount: number
  expenseCount: number
  totalSeconds: number
  billableSeconds: number
  nonbillableSeconds: number
  createdAt: string
  updatedAt: string
}

export interface TimesheetSubmissionEntryRecord {
  id: number
  spentDate: string
  projectId: number
  projectName: string
  taskId: number
  taskName: string
  seconds: number
  notes: string | null
}

export interface TimesheetSubmissionExpenseRecord {
  id: number
  spentDate: string
  projectId: number
  projectName: string
  expenseCategoryId: number
  expenseCategoryName: string
  totalCostCents: number
  currency: string
  notes: string | null
}

export interface TimesheetSubmissionDetailRecord extends TimesheetSubmissionRecord {
  entries: readonly TimesheetSubmissionEntryRecord[]
  expenses: readonly TimesheetSubmissionExpenseRecord[]
}

export interface TimesheetSubmissionFilters {
  periodStart?: string
  periodEnd?: string
  userId?: number
  clientId?: number
  projectId?: number
}

export interface TimesheetApprovalActor {
  userId: number
  profile: UserProfile
}

export interface TimesheetBulkApprovalSelection {
  submissionId: number
  expectedVersion: number
}

export interface TimesheetApprovalService {
  assertEnabled(): Promise<void>
  get(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
  ): Promise<TimesheetSubmissionDetailRecord>
  ownSubmissions(
    userId: number,
    filters: Readonly<TimesheetSubmissionFilters>,
  ): CursorSource<TimesheetSubmissionRecord>
  pendingSubmissions(
    actor: Readonly<TimesheetApprovalActor>,
    filters: Readonly<TimesheetSubmissionFilters>,
  ): CursorSource<TimesheetSubmissionRecord>
  approvedSubmissions(
    actor: Readonly<TimesheetApprovalActor>,
    filters: Readonly<TimesheetSubmissionFilters>,
  ): CursorSource<TimesheetSubmissionRecord>
  submit(
    userId: number,
    periodStart: string,
    periodEnd: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord>
  approve(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord>
  bulkApprove(
    actor: Readonly<TimesheetApprovalActor>,
    commandId: string,
    selections: readonly TimesheetBulkApprovalSelection[],
    occurredAt: string,
  ): Promise<readonly TimesheetSubmissionRecord[]>
  reject(
    actor: Readonly<TimesheetApprovalActor>,
    submissionId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord>
}

export interface TimesheetApprovalRouteOptions {
  service: TimesheetApprovalService
  cursorSigningKey: Uint8Array
  clock(): string
}

interface ServiceError {
  code:
    | 'module_disabled'
    | 'not_found'
    | 'forbidden'
    | 'empty_period'
    | 'running_entry'
    | 'period_overlap'
    | 'state_conflict'
  message: string
  /** Present only on a refused bulk approval: the selections it refused. */
  submissionIds?: readonly number[]
}

const serviceError = (error: unknown): error is ServiceError => {
  if (typeof error !== 'object' || error === null) return false
  const code = Reflect.get(error, 'code')
  return (
    typeof Reflect.get(error, 'message') === 'string' &&
    typeof code === 'string' &&
    new Set([
      'module_disabled',
      'not_found',
      'forbidden',
      'empty_period',
      'running_entry',
      'period_overlap',
      'state_conflict',
    ]).has(code)
  )
}

const translate = (error: unknown): never => {
  if (!serviceError(error)) throw error
  if (error.code === 'module_disabled' || error.code === 'not_found') {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The requested resource does not exist.',
    })
  }
  if (error.code === 'forbidden') {
    throw new ApiError({ status: 403, code: 'row_forbidden', message: error.message })
  }
  if (error.code === 'period_overlap' || error.code === 'state_conflict') {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  const field = error.code === 'running_entry' ? 'period' : 'period_start'
  throw validationError([{ field, code: error.code, message: error.message }])
}

/**
 * A refused batch names the selections it refused. An approver told only that
 * "something" was stale has to rebuild the whole selection; told which rows,
 * the queue can keep them checked and they retry what actually failed.
 */
const translateBulk = (
  error: unknown,
  selections: readonly TimesheetBulkApprovalSelection[],
): never => {
  if (!serviceError(error) || error.submissionIds === undefined) return translate(error)
  if (error.code !== 'forbidden' && error.code !== 'state_conflict') return translate(error)
  const fields = error.submissionIds.map((submissionId) => ({
    field: `submissions[${selections.findIndex(
      (selection) => selection.submissionId === submissionId,
    )}].id`,
    code: error.code === 'forbidden' ? 'row_forbidden' : 'state_conflict',
    message: error.message,
  }))
  throw new ApiError({
    status: error.code === 'forbidden' ? 403 : 409,
    code: error.code === 'forbidden' ? 'row_forbidden' : 'state_conflict',
    message: error.message,
    fields,
  })
}

const assertAvailable = async (service: TimesheetApprovalService): Promise<void> => {
  try {
    await service.assertEnabled()
  } catch (error) {
    return translate(error)
  }
}

export const serializeTimesheetSubmission = (
  submission: Readonly<TimesheetSubmissionRecord>,
) => ({
  id: submission.id,
  user_id: submission.userId,
  user_name: submission.userName,
  period_start: submission.periodStart,
  period_end: submission.periodEnd,
  status: submission.status,
  origin: submission.origin,
  source_status: submission.sourceStatus,
  source_observed_at: submission.sourceObservedAt,
  submitted_by_user_id: submission.submittedByUserId,
  submitted_at: submission.submittedAt,
  reviewed_by_user_id: submission.reviewedByUserId,
  reviewed_at: submission.reviewedAt,
  rejection_reason: submission.rejectionReason,
  version: submission.version,
  entry_count: submission.entryCount,
  expense_count: submission.expenseCount,
  total_seconds: submission.totalSeconds,
  billable_seconds: submission.billableSeconds,
  nonbillable_seconds: submission.nonbillableSeconds,
  created_at: submission.createdAt,
  updated_at: submission.updatedAt,
})

const serializeDetail = (submission: Readonly<TimesheetSubmissionDetailRecord>) => ({
  ...serializeTimesheetSubmission(submission),
  entries: submission.entries.map((entry) => ({
    id: entry.id,
    spent_date: entry.spentDate,
    project_id: entry.projectId,
    project_name: entry.projectName,
    task_id: entry.taskId,
    task_name: entry.taskName,
    seconds: entry.seconds,
    notes: entry.notes,
  })),
  expenses: submission.expenses.map((expense) => ({
    id: expense.id,
    spent_date: expense.spentDate,
    project_id: expense.projectId,
    project_name: expense.projectName,
    expense_category_id: expense.expenseCategoryId,
    expense_category_name: expense.expenseCategoryName,
    total_cost_cents: expense.totalCostCents,
    currency: expense.currency,
    notes: expense.notes,
  })),
})

const listKeys = new Set([
  'cursor', 'per_page', 'period_start', 'period_end',
  'user_id', 'client_id', 'project_id',
])

const filters = (url: URL): TimesheetSubmissionFilters => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const periodStart = queryDate(params, 'period_start', errors)
  const periodEnd = queryDate(params, 'period_end', errors)
  const userId = queryPositiveInteger(params, 'user_id', errors)
  const clientId = queryPositiveInteger(params, 'client_id', errors)
  const projectId = queryPositiveInteger(params, 'project_id', errors)
  if (periodStart !== undefined && periodEnd !== undefined && periodStart > periodEnd) {
    errors.push({
      field: 'period_end',
      code: 'invalid_range',
      message: 'period_end must not precede period_start',
    })
  }
  assertFields(errors)
  return {
    ...(periodStart === undefined ? {} : { periodStart }),
    ...(periodEnd === undefined ? {} : { periodEnd }),
    ...(userId === undefined ? {} : { userId }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(projectId === undefined ? {} : { projectId }),
  }
}

const submitKeys = new Set(['period_start', 'period_end'])

const periodInput = (
  body: Record<string, unknown>,
): { periodStart: string; periodEnd: string } => {
  const errors = unknownFieldErrors(body, submitKeys)
  const periodStart = body.period_start
  const periodEnd = body.period_end
  if (typeof periodStart !== 'string' || !isCanonicalDate(periodStart)) {
    errors.push({
      field: 'period_start',
      code: periodStart === undefined ? 'required' : 'invalid_date',
      message: 'period_start must be a real canonical YYYY-MM-DD date',
    })
  }
  if (typeof periodEnd !== 'string' || !isCanonicalDate(periodEnd)) {
    errors.push({
      field: 'period_end',
      code: periodEnd === undefined ? 'required' : 'invalid_date',
      message: 'period_end must be a real canonical YYYY-MM-DD date',
    })
  }
  if (
    typeof periodStart === 'string' &&
    typeof periodEnd === 'string' &&
    isCanonicalDate(periodStart) &&
    isCanonicalDate(periodEnd)
  ) {
    const days =
      (Date.parse(`${periodEnd}T00:00:00.000Z`) -
        Date.parse(`${periodStart}T00:00:00.000Z`)) /
        86_400_000 +
      1
    if (days < 1 || days > 31) {
      errors.push({
        field: 'period_end',
        code: 'invalid_range',
        message: 'a timesheet period must contain between 1 and 31 inclusive days',
      })
    }
  }
  assertFields(errors)
  return { periodStart: periodStart as string, periodEnd: periodEnd as string }
}

const rejectKeys = new Set(['reason'])

const rejectionReason = (body: Record<string, unknown>): string => {
  const errors = unknownFieldErrors(body, rejectKeys)
  const value = body.reason
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    typeof value !== 'string' ||
    normalized.length === 0 ||
    Array.from(normalized).length > 10_000
  ) {
    errors.push({
      field: 'reason',
      code: value === undefined ? 'required' : 'invalid_string',
      message: 'reason must contain between 1 and 10000 characters',
    })
  }
  assertFields(errors)
  return normalized
}

const bulkApprovalKeys = new Set(['submissions'])
const selectionKeys = new Set(['id', 'expected_version'])
const commandIdPattern = /^[A-Za-z0-9._:-]{1,128}$/

const selectionInteger = (
  entry: Record<string, unknown>,
  key: 'id' | 'expected_version',
  index: number,
  minimum: number,
  errors: FieldError[],
): number | undefined => {
  const value = entry[key]
  if (Number.isSafeInteger(value) && (value as number) >= minimum) return value as number
  errors.push({
    field: `submissions[${index}].${key}`,
    code: value === undefined ? 'required' : 'invalid_integer',
    message:
      key === 'id'
        ? 'id must be a positive safe integer'
        : 'expected_version must be the nonnegative version the approver saw',
  })
  return undefined
}

/**
 * The selection is explicit: ids the approver actually ticked, each with the
 * version they were looking at. A filter is never re-run server side, because
 * "approve everything matching this filter" would approve rows the approver
 * never saw.
 */
const bulkApprovalInput = (
  body: Record<string, unknown>,
): TimesheetBulkApprovalSelection[] => {
  const errors = unknownFieldErrors(body, bulkApprovalKeys)
  const submissions = body.submissions
  if (!Array.isArray(submissions)) {
    errors.push({
      field: 'submissions',
      code: submissions === undefined ? 'required' : 'invalid_array',
      message: 'submissions must be an array of selected timesheet submissions',
    })
    assertFields(errors)
  }
  const entries = submissions as readonly unknown[]
  if (entries.length === 0 || entries.length > maximumBulkApprovalSelections) {
    errors.push({
      field: 'submissions',
      code: 'invalid_length',
      message: `submissions must contain between 1 and ${maximumBulkApprovalSelections} selections`,
    })
    assertFields(errors)
  }
  const selections: TimesheetBulkApprovalSelection[] = []
  const seen = new Set<number>()
  entries.forEach((entry, index) => {
    if (!isJsonObject(entry)) {
      errors.push({
        field: `submissions[${index}]`,
        code: 'invalid_object',
        message: 'each selection must be an object with an id and an expected_version',
      })
      return
    }
    errors.push(
      ...unknownFieldErrors(entry, selectionKeys).map((error) => ({
        ...error,
        field: `submissions[${index}].${error.field}`,
      })),
    )
    const submissionId = selectionInteger(entry, 'id', index, 1, errors)
    const expectedVersion = selectionInteger(entry, 'expected_version', index, 0, errors)
    if (submissionId === undefined || expectedVersion === undefined) return
    if (seen.has(submissionId)) {
      errors.push({
        field: `submissions[${index}].id`,
        code: 'duplicate',
        message: 'a timesheet submission may only be selected once',
      })
      return
    }
    seen.add(submissionId)
    selections.push({ submissionId, expectedVersion })
  })
  assertFields(errors)
  return selections
}

const commandIdentity = (raw: string | undefined): string => {
  if (raw !== undefined && commandIdPattern.test(raw)) return raw
  throw validationError([
    {
      field: 'Idempotency-Key',
      code: raw === undefined ? 'required' : 'invalid_command_id',
      message:
        'Idempotency-Key must use 1-128 ASCII letters, digits, dot, underscore, colon, or dash.',
    },
  ])
}

const actor = (principal: Readonly<UserPrincipal>): TimesheetApprovalActor => ({
  userId: principal.userId,
  profile: principal.profile,
})

const assertApproverProfile = (principal: Readonly<UserPrincipal>): void => {
  if (canReviewSubmissions(principal.profile)) return
  throw new ApiError({
    status: 403,
    code: 'profile_forbidden',
    message: 'The acting user profile cannot review timesheet submissions.',
  })
}

const envelope = (submission: TimesheetSubmissionRecord) => ({
  data: serializeTimesheetSubmission(submission),
  links: { self: `/api/v1/timesheet-submissions/${submission.id}` },
})

export const installTimesheetApprovalRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: TimesheetApprovalRouteOptions,
): void => {
  api.get('/timesheet-submissions', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:read')
    requireApiScope(context, 'expenses:read')
    const principal = context.get('principal')
    const url = new URL(context.req.url)
    try {
      return context.json(
        await cursorPage({
          requestUrl: url,
          source: options.service.ownSubmissions(principal.userId, filters(url)),
          viewer: principal,
          serializer: (submission) => serializeTimesheetSubmission(submission),
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/timesheet-submissions', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const principal = context.get('principal')
    const input = periodInput(await readObjectBody(context))
    try {
      const submission = await options.service.submit(
        principal.userId,
        input.periodStart,
        input.periodEnd,
        options.clock(),
      )
      const response = envelope(submission)
      return submission.version === 0
        ? context.json(response, 201, {
            'cache-control': 'no-store',
            location: response.links.self,
          })
        : context.json(response, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/timesheet-submissions/pending', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:read')
    requireApiScope(context, 'expenses:read')
    const principal = context.get('principal')
    assertApproverProfile(principal)
    const url = new URL(context.req.url)
    try {
      return context.json(
        await cursorPage({
          requestUrl: url,
          source: options.service.pendingSubmissions(actor(principal), filters(url)),
          viewer: principal,
          serializer: (submission) => serializeTimesheetSubmission(submission),
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/timesheet-submissions/approved', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:read')
    requireApiScope(context, 'expenses:read')
    const principal = context.get('principal')
    assertApproverProfile(principal)
    const url = new URL(context.req.url)
    try {
      return context.json(
        await cursorPage({
          requestUrl: url,
          source: options.service.approvedSubmissions(actor(principal), filters(url)),
          viewer: principal,
          serializer: (submission) => serializeTimesheetSubmission(submission),
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/timesheet-submissions/bulk-approve', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const principal = context.get('principal')
    assertApproverProfile(principal)
    const commandId = commandIdentity(context.req.header('idempotency-key'))
    const selections = bulkApprovalInput(await readObjectBody(context))
    try {
      const approved = await options.service.bulkApprove(
        actor(principal),
        commandId,
        selections,
        options.clock(),
      )
      return context.json(
        {
          data: approved.map((submission) => serializeTimesheetSubmission(submission)),
          links: { self: '/api/v1/timesheet-submissions/bulk-approve' },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateBulk(error, selections)
    }
  })

  api.get('/timesheet-submissions/:id', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:read')
    requireApiScope(context, 'expenses:read')
    const principal = context.get('principal')
    try {
      const submission = await options.service.get(
        actor(principal),
        resourceId(context.req.param('id'), 'timesheet submission'),
      )
      return context.json(
        {
          data: serializeDetail(submission),
          links: { self: `/api/v1/timesheet-submissions/${submission.id}` },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/timesheet-submissions/:id/approve', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const principal = context.get('principal')
    assertApproverProfile(principal)
    try {
      const submission = await options.service.approve(
        actor(principal),
        resourceId(context.req.param('id'), 'timesheet submission'),
        options.clock(),
      )
      return context.json(envelope(submission), 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/timesheet-submissions/:id/reject', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const principal = context.get('principal')
    assertApproverProfile(principal)
    const reason = rejectionReason(await readObjectBody(context))
    try {
      const submission = await options.service.reject(
        actor(principal),
        resourceId(context.req.param('id'), 'timesheet submission'),
        reason,
        options.clock(),
      )
      return context.json(envelope(submission), 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translate(error)
    }
  })
}
