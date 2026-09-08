import {
  canViewMoneyField,
  maximumTimeEntryNoteLength,
  type ApprovalStatus,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireApiScope, requireSessionPrincipal } from '../auth.js'
import type { ApiContext, UserPrincipal } from '../context.js'
import { ApiError, type FieldError } from '../errors.js'
import { cursorPage } from '../pagination.js'
import { serializeOne } from '../serializer.js'
import {
  assertFields,
  optionalBoolean,
  optionalDate,
  optionalNonnegativeInteger,
  optionalNullableObject,
  optionalNullableString,
  optionalPositiveInteger,
  optionalTime,
  queryBoolean,
  queryDate,
  queryEnum,
  queryNonemptyString,
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
  CreateTimeEntryRequest,
  OrganizationTimeEntrySettings,
  OrganizationTimeEntryNoteSettings,
  TimeEntryFilters,
  TimeEntryRecord,
  TrackedResourceClock,
  TrackedResourceRepository,
  UpdateTimeEntryRequest,
  UpdateOrganizationTimeEntryNoteSettings,
} from './tracked-repository.js'

export interface TimeEntryRouteOptions {
  repository: TrackedResourceRepository
  clock: TrackedResourceClock
  cursorSigningKey: Uint8Array
}

interface TimeEntryOutput {
  id: number
  user_id: number
  project_id: number
  task_id: number
  user_assignment_id: number
  task_assignment_id: number
  spent_date: string
  seconds: number
  seconds_without_timer: number
  rounded_seconds: number
  is_running: boolean
  timer_started_at: string | null
  started_time: string | null
  ended_time: string | null
  notes: string | null
  billable: boolean
  budgeted: boolean
  approval_status: ApprovalStatus
  /**
   * The approval state this row carried in the system it was imported from.
   * See the note on the expense output: `approval_status` is what this
   * instance decided, which on an instance with the approval module off is
   * `unsubmitted` for every row. Null on anything this instance created.
   */
  source_approval_status: ApprovalStatus | null
  invoice_id: number | null
  is_billed: boolean
  is_locked: boolean
  locked_reason_code: string | null
  locked_reason: string | null
  external_ref: Record<string, unknown> | null
  calendar_event_ref: Record<string, unknown> | null
  minimum_note_length: number
  billable_rate_cents?: number | null
  cost_rate_cents?: number | null
  created_at: string
  updated_at: string
}

export const serializeTimeEntry = (
  entry: Readonly<TimeEntryRecord>,
  viewer: Readonly<UserPrincipal>,
): TimeEntryOutput => ({
  id: entry.id,
  user_id: entry.userId,
  project_id: entry.projectId,
  task_id: entry.taskId,
  user_assignment_id: entry.userAssignmentId,
  task_assignment_id: entry.taskAssignmentId,
  spent_date: entry.spentDate,
  seconds: entry.seconds,
  seconds_without_timer: entry.secondsWithoutTimer,
  rounded_seconds: entry.roundedSeconds,
  is_running:
    entry.timerStartedAt !== null ||
    (entry.startedTime !== null && entry.endedTime === null),
  timer_started_at: entry.timerStartedAt,
  started_time: entry.startedTime,
  ended_time: entry.endedTime,
  notes: entry.notes,
  billable: entry.billable,
  budgeted: entry.budgeted,
  approval_status: entry.state.approvalStatus,
  source_approval_status: entry.sourceApprovalStatus,
  invoice_id: entry.state.invoiceId,
  is_billed: entry.state.isBilled,
  is_locked: entry.state.isLocked,
  locked_reason_code: entry.state.lockedReasonCode,
  locked_reason: entry.state.lockedReason,
  external_ref: entry.externalRef,
  calendar_event_ref: entry.calendarEventRef,
  minimum_note_length: entry.noteMinimumLength,
  ...(canViewMoneyField(viewer, 'billable_rate')
    ? { billable_rate_cents: entry.billableRateCents }
    : {}),
  ...(canViewMoneyField(viewer, 'cost_rate')
    ? { cost_rate_cents: entry.costRateCents }
    : {}),
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
})

const listKeys = new Set([
  'cursor',
  'per_page',
  'user_id',
  'client_id',
  'project_id',
  'task_id',
  'spent_date',
  'from',
  'to',
  'approval_status',
  'invoice_id',
  'is_billed',
  'is_running',
  'billable',
  'budgeted',
  'external_reference_id',
  'updated_since',
])

const timeFilters = (
  url: URL,
  principal: Readonly<UserPrincipal>,
): TimeEntryFilters => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const userId = queryPositiveInteger(params, 'user_id', errors)
  const clientId = queryPositiveInteger(params, 'client_id', errors)
  const projectId = queryPositiveInteger(params, 'project_id', errors)
  const taskId = queryPositiveInteger(params, 'task_id', errors)
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
  const isRunning = queryBoolean(params, 'is_running', errors)
  const billable = queryBoolean(params, 'billable', errors)
  const budgeted = queryBoolean(params, 'budgeted', errors)
  const externalReferenceId = queryNonemptyString(
    params,
    'external_reference_id',
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
  if (userId !== undefined && userId !== principal.userId) {
    throw new ApiError({
      status: 403,
      code: 'row_forbidden',
      message: 'Time entries are limited to the acting user.',
    })
  }
  return {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(spentDate !== undefined ? { spentDate } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(approvalStatus !== undefined ? { approvalStatus } : {}),
    ...(invoiceId !== undefined ? { invoiceId } : {}),
    ...(isBilled !== undefined ? { isBilled } : {}),
    ...(isRunning !== undefined ? { isRunning } : {}),
    ...(billable !== undefined ? { billable } : {}),
    ...(budgeted !== undefined ? { budgeted } : {}),
    ...(externalReferenceId !== undefined ? { externalReferenceId } : {}),
    ...(updatedSince !== undefined ? { updatedSince } : {}),
  }
}

const bodyKeys = new Set([
  'project_id',
  'task_id',
  'spent_date',
  'seconds',
  'started_time',
  'ended_time',
  'notes',
  'budgeted',
  'external_ref',
  'calendar_event_ref',
])

const createInput = (body: Record<string, unknown>): CreateTimeEntryRequest => {
  const errors = unknownFieldErrors(body, bodyKeys)
  const projectId = requiredPositiveInteger(body, 'project_id', errors)
  const taskId = requiredPositiveInteger(body, 'task_id', errors)
  const spentDate = optionalDate(body, 'spent_date', errors)
  const seconds = optionalNonnegativeInteger(body, 'seconds', errors)
  const startedTime = optionalTime(body, 'started_time', errors)
  const endedTime = optionalTime(body, 'ended_time', errors)
  const notes = optionalNullableString(body, 'notes', errors)
  const budgeted = optionalBoolean(body, 'budgeted', errors)
  const externalRef = optionalNullableObject(body, 'external_ref', errors)
  const calendarEventRef = optionalNullableObject(
    body,
    'calendar_event_ref',
    errors,
  )
  assertFields(errors)
  return {
    projectId: projectId!,
    taskId: taskId!,
    ...(spentDate !== undefined ? { spentDate } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(startedTime !== undefined ? { startedTime } : {}),
    ...(endedTime !== undefined ? { endedTime } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(budgeted !== undefined ? { budgeted } : {}),
    ...(externalRef !== undefined ? { externalRef } : {}),
    ...(calendarEventRef !== undefined ? { calendarEventRef } : {}),
  }
}

const updateInput = (body: Record<string, unknown>): UpdateTimeEntryRequest => {
  const errors = unknownFieldErrors(body, bodyKeys)
  if (!Object.keys(body).some((key) => bodyKeys.has(key))) {
    errors.push({
      field: 'body',
      code: 'empty',
      message: 'at least one writable field is required',
    })
  }
  const projectId = optionalPositiveInteger(body, 'project_id', errors)
  const taskId = optionalPositiveInteger(body, 'task_id', errors)
  const spentDate = optionalDate(body, 'spent_date', errors)
  const seconds = optionalNonnegativeInteger(body, 'seconds', errors)
  const startedTime = optionalTime(body, 'started_time', errors)
  const endedTime = optionalTime(body, 'ended_time', errors)
  const notes = optionalNullableString(body, 'notes', errors)
  const budgeted = optionalBoolean(body, 'budgeted', errors)
  const externalRef = optionalNullableObject(body, 'external_ref', errors)
  const calendarEventRef = optionalNullableObject(
    body,
    'calendar_event_ref',
    errors,
  )
  assertFields(errors)
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(spentDate !== undefined ? { spentDate } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(startedTime !== undefined ? { startedTime } : {}),
    ...(endedTime !== undefined ? { endedTime } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(budgeted !== undefined ? { budgeted } : {}),
    ...(externalRef !== undefined ? { externalRef } : {}),
    ...(calendarEventRef !== undefined ? { calendarEventRef } : {}),
  }
}

const selfLink = (id: number) => `/api/v1/time-entries/${id}`

const serializeTimeEntrySettings = (
  settings: Readonly<OrganizationTimeEntrySettings>,
) => ({
  time_entry_mode: settings.mode,
  time_format: settings.timeFormat,
  clock: settings.clock,
  week_start_day: settings.weekStartDay,
})

const noteSettingsBodyKeys = new Set(['required', 'minimum_length'])

const noteSettingsInput = (
  body: Record<string, unknown>,
): UpdateOrganizationTimeEntryNoteSettings => {
  const errors = unknownFieldErrors(body, noteSettingsBodyKeys)
  if (!Object.keys(body).some((key) => noteSettingsBodyKeys.has(key))) {
    errors.push({
      field: 'body',
      code: 'empty',
      message: 'at least one writable field is required',
    })
  }
  const required = optionalBoolean(body, 'required', errors)
  const minimumLength = optionalPositiveInteger(body, 'minimum_length', errors)
  if (
    minimumLength !== undefined &&
    minimumLength > maximumTimeEntryNoteLength
  ) {
    errors.push({
      field: 'minimum_length',
      code: 'too_large',
      message: `minimum_length must not exceed ${maximumTimeEntryNoteLength}`,
    })
  }
  assertFields(errors)
  return {
    ...(required !== undefined ? { required } : {}),
    ...(minimumLength !== undefined ? { minimumLength } : {}),
  }
}

const serializeNoteSettings = (
  settings: Readonly<OrganizationTimeEntryNoteSettings>,
) => ({
  required: settings.required,
  minimum_length: settings.minimumLength,
})

export const installTimeEntryRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: TimeEntryRouteOptions,
): void => {
  api.get('/time-entry-settings', async (context) => {
    requireApiScope(context, 'time_entries:read')
    return context.json(
      {
        data: serializeTimeEntrySettings(
          await options.repository.timeEntrySettings(),
        ),
        links: { self: '/api/v1/time-entry-settings' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/time-entry-note-settings', async (context) => {
    requireApiScope(context, 'time_entries:read')
    return context.json(
      {
        data: serializeNoteSettings(
          await options.repository.timeEntryNoteSettings(),
        ),
        links: { self: '/api/v1/time-entry-note-settings' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.patch('/time-entry-note-settings', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = requireSessionPrincipal(context)
    if (
      principal.profile !== 'executive_manager' &&
      principal.profile !== 'administrator'
    ) {
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only executive managers and administrators can change organization note settings.',
      })
    }
    const settings = await options.repository.updateTimeEntryNoteSettings(
      noteSettingsInput(await readObjectBody(context)),
      options.clock.now().instant,
    )
    return context.json(
      {
        data: serializeNoteSettings(settings),
        links: { self: '/api/v1/time-entry-note-settings' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/time-entry-options', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    try {
      const rows = await options.repository.timeEntryOptions(principal.userId)
      return context.json(
        {
          data: rows.map((row) => ({
            project_id: row.projectId,
            task_id: row.taskId,
            minimum_note_length: row.noteMinimumLength,
          })),
          links: { self: '/api/v1/time-entry-options' },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })

  api.get('/time-entries', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    try {
      const url = new URL(context.req.url)
      const filters = timeFilters(url, principal)
      const envelope = await cursorPage({
        requestUrl: url,
        source: options.repository.timeEntries(principal.userId, filters),
        viewer: principal,
        serializer: serializeTimeEntry,
        cursorSigningKey: options.cursorSigningKey,
      })
      return context.json(envelope, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })

  api.post('/time-entries', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const input = createInput(await readObjectBody(context))
      const entry = await options.repository.createTimeEntry(
        principal.userId,
        input,
        options.clock.now(),
      )
      return context.json(
        {
          data: serializeOne(entry, principal, serializeTimeEntry),
          links: { self: selfLink(entry.id) },
        },
        201,
        { 'cache-control': 'no-store', location: selfLink(entry.id) },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })

  api.get('/time-entries/:id', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.getTimeEntry(
        principal.userId,
        resourceId(context.req.param('id'), 'time entry'),
      )
      return context.json(
        {
          data: serializeOne(entry, principal, serializeTimeEntry),
          links: { self: selfLink(entry.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })

  api.patch('/time-entries/:id', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.updateTimeEntry(
        principal.userId,
        resourceId(context.req.param('id'), 'time entry'),
        updateInput(await readObjectBody(context)),
        options.clock.now(),
      )
      return context.json(
        {
          data: serializeOne(entry, principal, serializeTimeEntry),
          links: { self: selfLink(entry.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })

  api.delete('/time-entries/:id', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.deleteTimeEntry(
        principal.userId,
        resourceId(context.req.param('id'), 'time entry'),
      )
      return context.json(
        {
          data: serializeOne(entry, principal, serializeTimeEntry),
          links: { self: selfLink(entry.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })

  api.post('/time-entries/:id/stop', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.stopTimeEntry(
        principal.userId,
        resourceId(context.req.param('id'), 'time entry'),
        options.clock.now(),
      )
      return context.json(
        {
          data: serializeOne(entry, principal, serializeTimeEntry),
          links: { self: selfLink(entry.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })

  api.post('/time-entries/:id/restart', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.restartTimeEntry(
        principal.userId,
        resourceId(context.req.param('id'), 'time entry'),
        options.clock.now(),
      )
      return context.json(
        {
          data: serializeOne(entry, principal, serializeTimeEntry),
          links: { self: selfLink(entry.id) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry')
    }
  })
}
