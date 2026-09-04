import type { Context, Hono } from 'hono'
import { requireApiScope, requireSessionPrincipal } from './auth.js'
import type { ApiContext, UserPrincipal, UserProfile } from './context.js'
import { ApiError, validationError, type FieldError } from './errors.js'
import { cursorPage, type CursorSource } from './pagination.js'
import {
  assertFields,
  isCanonicalDate,
  isCanonicalTime,
  queryBoolean,
  queryEnum,
  readObjectBody,
  resourceId,
  strictSearchParams,
  unknownFieldErrors,
} from './resources/support.js'
import {
  serializeTimesheetSubmission,
  type TimesheetSubmissionRecord,
} from './timesheet-approvals.js'

export type TimesheetDeadlineDay =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'

export interface TimesheetDeadline {
  day: TimesheetDeadlineDay
  time: string
}

export interface TimesheetLockPolicyActor {
  userId: number
  profile: UserProfile
}

export interface TimesheetLockPolicySettings {
  autoLock: boolean
  timesheetDeadline: TimesheetDeadline | null
  timezone: string
  weekStartDay: 'saturday' | 'sunday' | 'monday'
  updatedAt: string
}

export interface UpdateTimesheetLockPolicySettings {
  autoLock?: boolean
  timesheetDeadline?: TimesheetDeadline | null
  timezone?: string
}

export interface TimesheetLockWindowRecord {
  id: number
  kind: 'manual_cutoff' | 'weekly_deadline'
  periodStart: string | null
  periodEnd: string
  lockReason: string
  lockedByUserId: number | null
  lockedAt: string
  unlockedByUserId: number | null
  unlockedAt: string | null
  unlockReason: string | null
}

export interface TimesheetLockFilters {
  active?: boolean
  kind?: 'manual_cutoff' | 'weekly_deadline'
}

export interface TimesheetLockPolicyService {
  assertApprovalEnabled(): Promise<void>
  settings(): Promise<TimesheetLockPolicySettings>
  updateSettings(
    actor: Readonly<TimesheetLockPolicyActor>,
    input: Readonly<UpdateTimesheetLockPolicySettings>,
    occurredAt: string,
  ): Promise<TimesheetLockPolicySettings>
  lockWindow(lockId: number): Promise<TimesheetLockWindowRecord>
  lockWindows(filters: Readonly<TimesheetLockFilters>): CursorSource<TimesheetLockWindowRecord>
  createManualLock(
    actor: Readonly<TimesheetLockPolicyActor>,
    lockedThrough: string,
    reason: string,
    occurredAt: string,
    commandId: string,
    inputFingerprint: string,
  ): Promise<TimesheetLockWindowRecord>
  materializeAutoLocks(occurredAt: string): Promise<unknown>
  unlock(
    actor: Readonly<TimesheetLockPolicyActor>,
    lockId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetLockWindowRecord>
  withdrawTimesheet(
    actor: Readonly<TimesheetLockPolicyActor>,
    submissionId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord>
}

export interface TimesheetLockPolicyRouteOptions {
  service: TimesheetLockPolicyService
  cursorSigningKey: Uint8Array
  clock(): string
}

interface ServiceError {
  code: string
  message: string
}

const serviceError = (error: unknown): error is ServiceError =>
  typeof error === 'object' &&
  error !== null &&
  typeof Reflect.get(error, 'code') === 'string' &&
  typeof Reflect.get(error, 'message') === 'string'

const translate = (error: unknown): never => {
  if (!serviceError(error)) throw error
  if (error.code === 'not_found') {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The requested lock or timesheet does not exist.',
    })
  }
  if (error.code === 'module_disabled') {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The requested lock or timesheet does not exist.',
    })
  }
  if (error.code === 'forbidden') {
    throw new ApiError({ status: 403, code: 'profile_forbidden', message: error.message })
  }
  if (error.code === 'state_conflict' || error.code === 'running_entry') {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  if (error.code === 'command_id_reused') {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  if (error.code === 'invalid_settings') {
    throw validationError([
      { field: 'timesheet_deadline', code: error.code, message: error.message },
    ])
  }
  throw error
}

const actor = (
  principal: Readonly<UserPrincipal>,
): TimesheetLockPolicyActor => ({ userId: principal.userId, profile: principal.profile })

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): TimesheetLockPolicyActor => {
  const principal = requireSessionPrincipal(context)
  if (
    principal.profile !== 'administrator' &&
    principal.profile !== 'executive_manager'
  ) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only executive managers and administrators can manage timesheet locks.',
    })
  }
  return actor(principal)
}

const days = new Set<TimesheetDeadlineDay>([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
])

const nonemptyReason = (
  value: unknown,
  field: string,
  errors: FieldError[],
): string | undefined => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    typeof value !== 'string' ||
    normalized.length === 0 ||
    Array.from(normalized).length > 10_000
  ) {
    errors.push({
      field,
      code: value === undefined ? 'required' : 'invalid_string',
      message: `${field} must contain between 1 and 10000 characters`,
    })
    return undefined
  }
  return normalized
}

const timezone = (value: unknown, errors: FieldError[]): string | undefined => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    errors.push({
      field: 'timezone',
      code: value === undefined ? 'required' : 'invalid_timezone',
      message: 'timezone must be an IANA timezone name',
    })
    return undefined
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
  } catch {
    errors.push({
      field: 'timezone',
      code: 'invalid_timezone',
      message: 'timezone must be an IANA timezone name',
    })
    return undefined
  }
  return value
}

const deadline = (value: unknown, errors: FieldError[]): TimesheetDeadline | null | undefined => {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      field: 'timesheet_deadline',
      code: 'invalid_object',
      message: 'timesheet_deadline must be an object with day and time, or null',
    })
    return undefined
  }
  const input = value as Record<string, unknown>
  errors.push(...unknownFieldErrors(input, new Set(['day', 'time'])))
  const day = input.day
  const time = input.time
  if (typeof day !== 'string' || !days.has(day as TimesheetDeadlineDay)) {
    errors.push({
      field: 'timesheet_deadline.day',
      code: day === undefined ? 'required' : 'invalid_enum',
      message: 'timesheet_deadline.day must be a weekday name',
    })
  }
  if (typeof time !== 'string' || !isCanonicalTime(time)) {
    errors.push({
      field: 'timesheet_deadline.time',
      code: time === undefined ? 'required' : 'invalid_time',
      message: 'timesheet_deadline.time must be canonical HH:MM',
    })
  }
  if (
    typeof day !== 'string' ||
    !days.has(day as TimesheetDeadlineDay) ||
    typeof time !== 'string' ||
    !isCanonicalTime(time)
  ) return undefined
  return { day: day as TimesheetDeadlineDay, time }
}

const policyKeys = new Set(['auto_lock', 'timesheet_deadline', 'timezone'])

const policyInput = (body: Record<string, unknown>): UpdateTimesheetLockPolicySettings => {
  const errors = unknownFieldErrors(body, policyKeys)
  if (!Object.keys(body).some((key) => policyKeys.has(key))) {
    errors.push({
      field: 'body',
      code: 'empty',
      message: 'at least one writable field is required',
    })
  }
  let autoLock: boolean | undefined
  if (Object.hasOwn(body, 'auto_lock')) {
    if (typeof body.auto_lock !== 'boolean') {
      errors.push({
        field: 'auto_lock',
        code: 'invalid_boolean',
        message: 'auto_lock must be a boolean',
      })
    } else autoLock = body.auto_lock
  }
  const timesheetDeadline = Object.hasOwn(body, 'timesheet_deadline')
    ? deadline(body.timesheet_deadline, errors)
    : undefined
  const timeZone = Object.hasOwn(body, 'timezone')
    ? timezone(body.timezone, errors)
    : undefined
  assertFields(errors)
  return {
    ...(autoLock === undefined ? {} : { autoLock }),
    ...(timesheetDeadline === undefined ? {} : { timesheetDeadline }),
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
  }
}

const manualKeys = new Set(['locked_through', 'reason'])
const commandIdPattern = /^[A-Za-z0-9._:-]{1,128}$/

const idempotencyKey = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): string => {
  const value = context.req.header('idempotency-key')
  if (value === undefined || !commandIdPattern.test(value)) {
    throw validationError([{
      field: 'Idempotency-Key',
      code: value === undefined ? 'required' : 'invalid_command_id',
      message:
        'Idempotency-Key must use 1-128 ASCII letters, digits, dot, underscore, colon, or dash.',
    }])
  }
  return value
}

const manualFingerprint = async (input: {
  lockedThrough: string
  reason: string
}): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([input.lockedThrough, input.reason])),
    ),
  )
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const manualInput = (body: Record<string, unknown>): { lockedThrough: string; reason: string } => {
  const errors = unknownFieldErrors(body, manualKeys)
  const lockedThrough = body.locked_through
  if (typeof lockedThrough !== 'string' || !isCanonicalDate(lockedThrough)) {
    errors.push({
      field: 'locked_through',
      code: lockedThrough === undefined ? 'required' : 'invalid_date',
      message: 'locked_through must be a real canonical YYYY-MM-DD date',
    })
  }
  const reason = nonemptyReason(body.reason, 'reason', errors)
  assertFields(errors)
  return { lockedThrough: lockedThrough as string, reason: reason! }
}

const reasonInput = (body: Record<string, unknown>): string => {
  const errors = unknownFieldErrors(body, new Set(['reason']))
  const reason = nonemptyReason(body.reason, 'reason', errors)
  assertFields(errors)
  return reason!
}

const serializeSettings = (settings: Readonly<TimesheetLockPolicySettings>) => ({
  auto_lock: settings.autoLock,
  timesheet_deadline: settings.timesheetDeadline,
  timezone: settings.timezone,
  week_start_day: settings.weekStartDay,
  updated_at: settings.updatedAt,
})

const serializeWindow = (window: Readonly<TimesheetLockWindowRecord>) => ({
  id: window.id,
  kind: window.kind === 'manual_cutoff' ? 'manual' as const : 'auto' as const,
  period_start: window.periodStart,
  period_end: window.periodEnd,
  reason: window.lockReason,
  locked_by_user_id: window.lockedByUserId,
  locked_at: window.lockedAt,
  unlocked_by_user_id: window.unlockedByUserId,
  unlocked_at: window.unlockedAt,
  unlock_reason: window.unlockReason,
  active: window.unlockedAt === null,
})

const settingsEnvelope = (settings: TimesheetLockPolicySettings) => ({
  data: serializeSettings(settings),
  links: { self: '/api/v1/timesheet-lock-policy' },
})

const windowEnvelope = (window: TimesheetLockWindowRecord) => ({
  data: serializeWindow(window),
  links: { self: `/api/v1/timesheet-locks/${window.id}` },
})

export const installTimesheetLockPolicyRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: TimesheetLockPolicyRouteOptions,
): void => {
  api.get('/timesheet-lock-policy', async (context) => {
    requireApiScope(context, 'time_entries:read')
    requireApiScope(context, 'expenses:read')
    assertAdministrator(context)
    return context.json(settingsEnvelope(await options.service.settings()), 200, {
      'cache-control': 'no-store',
    })
  })

  api.patch('/timesheet-lock-policy', async (context) => {
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const acting = assertAdministrator(context)
    const input = policyInput(await readObjectBody(context))
    try {
      return context.json(
        settingsEnvelope(await options.service.updateSettings(acting, input, options.clock())),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/timesheet-locks', async (context) => {
    requireApiScope(context, 'time_entries:read')
    requireApiScope(context, 'expenses:read')
    const principal = assertAdministrator(context)
    const url = new URL(context.req.url)
    const params = strictSearchParams(
      url,
      new Set(['cursor', 'per_page', 'active', 'kind']),
    )
    const errors: FieldError[] = []
    const active = queryBoolean(params, 'active', errors)
    const kind = queryEnum(params, 'kind', ['manual', 'auto'] as const, errors)
    assertFields(errors)
    try {
      await options.service.materializeAutoLocks(options.clock())
      return context.json(
        await cursorPage({
          requestUrl: url,
          source: options.service.lockWindows({
            ...(active === undefined ? {} : { active }),
            ...(kind === undefined
              ? {}
              : { kind: kind === 'manual' ? 'manual_cutoff' : 'weekly_deadline' }),
          }),
          viewer: principal,
          serializer: serializeWindow,
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/timesheet-locks/:id', async (context) => {
    requireApiScope(context, 'time_entries:read')
    requireApiScope(context, 'expenses:read')
    assertAdministrator(context)
    try {
      return context.json(
        windowEnvelope(
          await options.service.lockWindow(
            resourceId(context.req.param('id'), 'timesheet lock'),
          ),
        ),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/timesheet-locks', async (context) => {
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const acting = assertAdministrator(context)
    const commandId = idempotencyKey(context)
    const input = manualInput(await readObjectBody(context))
    try {
      const created = await options.service.createManualLock(
        acting,
        input.lockedThrough,
        input.reason,
        options.clock(),
        commandId,
        await manualFingerprint(input),
      )
      return context.json(windowEnvelope(created), 201, {
        'cache-control': 'no-store',
        location: `/api/v1/timesheet-locks/${created.id}`,
      })
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/timesheet-locks/:id/unlock', async (context) => {
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const acting = assertAdministrator(context)
    const reason = reasonInput(await readObjectBody(context))
    try {
      return context.json(
        windowEnvelope(
          await options.service.unlock(
            acting,
            resourceId(context.req.param('id'), 'timesheet lock'),
            reason,
            options.clock(),
          ),
        ),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/timesheet-submissions/:id/withdraw', async (context) => {
    try {
      await options.service.assertApprovalEnabled()
    } catch (error) {
      return translate(error)
    }
    requireApiScope(context, 'time_entries:write')
    requireApiScope(context, 'expenses:write')
    const acting = assertAdministrator(context)
    const reason = reasonInput(await readObjectBody(context))
    try {
      const submission = await options.service.withdrawTimesheet(
        acting,
        resourceId(context.req.param('id'), 'timesheet submission'),
        reason,
        options.clock(),
      )
      return context.json(
        {
          data: serializeTimesheetSubmission(submission),
          links: { self: `/api/v1/timesheet-submissions/${submission.id}` },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })
}
