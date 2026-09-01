import type { Hono } from 'hono'
import { requireApiScope } from './auth.js'
import type { ApiContext, UserPrincipal, UserProfile } from './context.js'
import { ApiError, validationError, type FieldError } from './errors.js'
import { cursorPage, type CursorSource } from './pagination.js'
import {
  assertFields,
  isCanonicalDate,
  queryDate,
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

export interface TimesheetSubmissionDetailRecord extends TimesheetSubmissionRecord {
  entries: readonly TimesheetSubmissionEntryRecord[]
}

export interface TimesheetSubmissionFilters {
  periodStart?: string
  periodEnd?: string
}

export interface TimesheetApprovalActor {
  userId: number
  profile: UserProfile
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

const assertAvailable = async (service: TimesheetApprovalService): Promise<void> => {
  try {
    await service.assertEnabled()
  } catch (error) {
    return translate(error)
  }
}

const serialize = (submission: Readonly<TimesheetSubmissionRecord>) => ({
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
  total_seconds: submission.totalSeconds,
  billable_seconds: submission.billableSeconds,
  nonbillable_seconds: submission.nonbillableSeconds,
  created_at: submission.createdAt,
  updated_at: submission.updatedAt,
})

const serializeDetail = (submission: Readonly<TimesheetSubmissionDetailRecord>) => ({
  ...serialize(submission),
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
})

const listKeys = new Set(['cursor', 'per_page', 'period_start', 'period_end'])

const filters = (url: URL): TimesheetSubmissionFilters => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const periodStart = queryDate(params, 'period_start', errors)
  const periodEnd = queryDate(params, 'period_end', errors)
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

const actor = (principal: Readonly<UserPrincipal>): TimesheetApprovalActor => ({
  userId: principal.userId,
  profile: principal.profile,
})

const assertApproverProfile = (principal: Readonly<UserPrincipal>): void => {
  if (
    principal.profile === 'administrator' ||
    principal.profile === 'executive_manager' ||
    principal.profile === 'project_manager'
  ) {
    return
  }
  throw new ApiError({
    status: 403,
    code: 'profile_forbidden',
    message: 'The acting user profile cannot review timesheet submissions.',
  })
}

const envelope = (submission: TimesheetSubmissionRecord) => ({
  data: serialize(submission),
  links: { self: `/api/v1/timesheet-submissions/${submission.id}` },
})

export const installTimesheetApprovalRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: TimesheetApprovalRouteOptions,
): void => {
  api.get('/timesheet-submissions', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    const url = new URL(context.req.url)
    try {
      return context.json(
        await cursorPage({
          requestUrl: url,
          source: options.service.ownSubmissions(principal.userId, filters(url)),
          viewer: principal,
          serializer: (submission) => serialize(submission),
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
    const principal = context.get('principal')
    assertApproverProfile(principal)
    const url = new URL(context.req.url)
    try {
      return context.json(
        await cursorPage({
          requestUrl: url,
          source: options.service.pendingSubmissions(actor(principal), filters(url)),
          viewer: principal,
          serializer: (submission) => serialize(submission),
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/timesheet-submissions/:id', async (context) => {
    await assertAvailable(options.service)
    requireApiScope(context, 'time_entries:read')
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
