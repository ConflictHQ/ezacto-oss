import {
  canManageTeammateTime,
  canViewMoneyField,
  maximumTimeEntryNoteLength,
  timeRoundingIncrements,
  timeRoundingModes,
  type ApprovalStatus,
  type EffectiveTimeRounding,
  type TimeRoundingPolicy,
  type TimeRoundingRecalculationPreview,
  type TimeRoundingRecalculationScope,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireApiScope, requireSessionPrincipal } from '../auth.js'
import type { ApiContext, UserPrincipal } from '../context.js'
import { ApiError, type FieldError } from '../errors.js'
import { cursorPage } from '../pagination.js'
import { serializeOne } from '../serializer.js'
import { authorizeInvoiceFilters, invoiceStateForViewer } from './invoice-visibility.js'
import {
  assertFields,
  optionalBoolean,
  optionalDate,
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
  UpdateOrganizationTimeRounding,
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
  invoice_id?: number | null
  is_billed?: boolean
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
  ...invoiceStateForViewer(entry.state, viewer),
  external_ref: entry.externalRef,
  calendar_event_ref: entry.calendarEventRef,
  minimum_note_length: entry.noteMinimumLength,
  // The subject is the row's own user, never the person asking. Passing
  // `viewer.userId` here would make the rule tautological and every entry the
  // viewer's own; passing the row's user is what makes it possible for the
  // answer to be no on somebody else's line, which is the whole safety of the
  // #520 setting.
  ...(canViewMoneyField(viewer, 'billable_rate', entry.userId)
    ? { billable_rate_cents: entry.billableRateCents }
    : {}),
  ...(canViewMoneyField(viewer, 'cost_rate', entry.userId)
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

/**
 * Naming another person's time, in a filter or a new entry, is an
 * administrator's alone (#917). Everyone else may name only themselves, which
 * is the same as naming nobody.
 */
export const assertMayNameUser = (
  principal: Readonly<UserPrincipal>,
  userId: number | undefined,
): void => {
  if (
    userId !== undefined &&
    userId !== principal.userId &&
    !canManageTeammateTime(principal.profile)
  ) {
    throw new ApiError({
      status: 403,
      code: 'row_forbidden',
      message: 'Time entries are limited to the acting user.',
    })
  }
}

const timeFilters = (
  url: URL,
  principal: Readonly<UserPrincipal>,
): TimeEntryFilters => {
  const params = strictSearchParams(url, listKeys)
  authorizeInvoiceFilters(params, principal)
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
  assertMayNameUser(principal, userId)
  return {
    ...(userId !== undefined ? { userId } : {}),
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

// Whose entry is chosen when it is created and never changed after, so only
// creation accepts `user_id`.
const createBodyKeys = new Set([...bodyKeys, 'user_id'])

const createInput = (body: Record<string, unknown>): CreateTimeEntryRequest => {
  const errors = unknownFieldErrors(body, createBodyKeys)
  const userId = optionalPositiveInteger(body, 'user_id', errors)
  const projectId = requiredPositiveInteger(body, 'project_id', errors)
  const taskId = requiredPositiveInteger(body, 'task_id', errors)
  const spentDate = optionalDate(body, 'spent_date', errors)
  const seconds = optionalPositiveInteger(body, 'seconds', errors)
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
    ...(userId !== undefined ? { userId } : {}),
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
  const seconds = optionalPositiveInteger(body, 'seconds', errors)
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

const optionKeys = new Set(['user_id'])

const serializeRounding = (rule: Readonly<TimeRoundingPolicy>) => ({
  mode: rule.mode,
  minutes: rule.minutes,
})

const serializeEffectiveRounding = (rule: Readonly<EffectiveTimeRounding>) => ({
  ...serializeRounding(rule),
  source: rule.source,
})

const roundingBodyKeys = new Set(['mode', 'minutes'])

const roundingSettingsInput = (
  body: Record<string, unknown>,
): UpdateOrganizationTimeRounding => {
  const errors = unknownFieldErrors(body, roundingBodyKeys)
  if (!Object.keys(body).some((key) => roundingBodyKeys.has(key))) {
    errors.push({
      field: 'body',
      code: 'empty',
      message: 'at least one writable field is required',
    })
  }
  const mode = body['mode']
  if (mode !== undefined && !(timeRoundingModes as readonly unknown[]).includes(mode)) {
    errors.push({
      field: 'mode',
      code: 'invalid_enum',
      message: `mode must be one of ${timeRoundingModes.join(', ')}`,
    })
  }
  const minutes = body['minutes']
  if (minutes !== undefined && !(timeRoundingIncrements as readonly unknown[]).includes(minutes)) {
    errors.push({
      field: 'minutes',
      code: 'invalid_integer',
      message: `minutes must be one of ${timeRoundingIncrements.join(', ')}`,
    })
  }
  assertFields(errors)
  return body as UpdateOrganizationTimeRounding
}

const recalculationKeys = new Set(['project_id', 'from', 'to'])

const serializeRecalculationScope = (scope: Readonly<TimeRoundingRecalculationScope>) => ({
  project_id: scope.projectId ?? null,
  from: scope.from ?? null,
  to: scope.to ?? null,
})

const serializeRecalculation = (preview: Readonly<TimeRoundingRecalculationPreview>) => ({
  scope: serializeRecalculationScope(preview.scope),
  open_entries: preview.openEntries,
  changed_entries: preview.changedEntries,
  rounded_seconds_before: preview.roundedSecondsBefore,
  rounded_seconds_after: preview.roundedSecondsAfter,
  earliest_spent_date: preview.earliestSpentDate,
  latest_spent_date: preview.latestSpentDate,
  projects: preview.projects.map((project) => ({
    project_id: project.projectId,
    project_name: project.projectName,
    time_rounding: serializeEffectiveRounding(project.timeRounding),
    changed_entries: project.changedEntries,
    rounded_seconds_before: project.roundedSecondsBefore,
    rounded_seconds_after: project.roundedSecondsAfter,
  })),
  kept: preview.kept,
  fingerprint: preview.fingerprint,
})

const recalculationScope = (
  projectId: number | undefined,
  from: string | undefined,
  to: string | undefined,
  errors: FieldError[],
): TimeRoundingRecalculationScope => {
  if (from !== undefined && to !== undefined && from > to) {
    errors.push({ field: 'from', code: 'out_of_order', message: 'from must not be after to' })
  }
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  }
}

const serializeTimeEntrySettings = (
  settings: Readonly<OrganizationTimeEntrySettings>,
) => ({
  time_entry_mode: settings.mode,
  time_format: settings.timeFormat,
  clock: settings.clock,
  week_start_day: settings.weekStartDay,
  time_rounding: serializeRounding(settings.timeRounding),
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

// Like the notes policy: the organization's rule decides what every invoice
// bills, so it is an administrator's, and a token never reaches it.
const requireRoundingAuthority = (principal: Readonly<UserPrincipal>): void => {
  if (principal.profile !== 'executive_manager' && principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only executive managers and administrators can change or recalculate time rounding.',
    })
  }
}

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

  api.patch('/time-entry-rounding-settings', async (context) => {
    requireApiScope(context, 'time_entries:write')
    requireRoundingAuthority(requireSessionPrincipal(context))
    const rule = await options.repository.updateTimeRoundingSettings(
      roundingSettingsInput(await readObjectBody(context)),
      options.clock.now().instant,
    )
    return context.json(
      {
        data: serializeRounding(rule),
        links: { self: '/api/v1/time-entry-rounding-settings' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  // Re-rounding open time under today's rules: a preview, then an apply that
  // names the preview it was shown (issue 949).
  api.get('/time-rounding-recalculation', async (context) => {
    requireApiScope(context, 'time_entries:read')
    requireRoundingAuthority(requireSessionPrincipal(context))
    const params = strictSearchParams(new URL(context.req.url), recalculationKeys)
    const errors: FieldError[] = []
    const scope = recalculationScope(
      queryPositiveInteger(params, 'project_id', errors),
      queryDate(params, 'from', errors),
      queryDate(params, 'to', errors),
      errors,
    )
    assertFields(errors)
    return context.json(
      {
        data: serializeRecalculation(
          await options.repository.previewTimeRoundingRecalculation(scope),
        ),
        links: { self: '/api/v1/time-rounding-recalculation' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/time-rounding-recalculation', async (context) => {
    requireApiScope(context, 'time_entries:write')
    requireRoundingAuthority(requireSessionPrincipal(context))
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, new Set([...recalculationKeys, 'fingerprint']))
    const scope = recalculationScope(
      optionalPositiveInteger(body, 'project_id', errors),
      optionalDate(body, 'from', errors),
      optionalDate(body, 'to', errors),
      errors,
    )
    const fingerprint = body['fingerprint']
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(fingerprint)) {
      errors.push({
        field: 'fingerprint',
        code: 'invalid',
        message: 'fingerprint must be the one a preview returned',
      })
    }
    assertFields(errors)
    const result = await options.repository.applyTimeRoundingRecalculation(
      scope,
      fingerprint as string,
      options.clock.now().instant,
    )
    if (result.status === 'stale') {
      throw new ApiError({
        status: 409,
        code: 'preview_stale',
        message:
          'The open entries changed since this preview. Preview again before recalculating.',
      })
    }
    return context.json(
      {
        data: {
          recalculated_entries: result.recalculatedEntries,
          preview: serializeRecalculation(result.preview),
        },
        links: { self: '/api/v1/time-rounding-recalculation' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/time-entry-options', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    try {
      // An administrator logging a teammate's time picks from that person's
      // assignments, not their own (#917).
      const params = strictSearchParams(new URL(context.req.url), optionKeys)
      const errors: FieldError[] = []
      const userId = queryPositiveInteger(params, 'user_id', errors)
      assertFields(errors)
      assertMayNameUser(principal, userId)
      const rows = await options.repository.timeEntryOptions(userId ?? principal.userId)
      return context.json(
        {
          data: rows.map((row) => ({
            project_id: row.projectId,
            task_id: row.taskId,
            minimum_note_length: row.noteMinimumLength,
            time_rounding: serializeEffectiveRounding(row.timeRounding),
          })),
          links: { self: '/api/v1/time-entry-options' },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateResourceError(error, 'time entry', principal)
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
        source: options.repository.timeEntries(principal, filters),
        viewer: principal,
        serializer: serializeTimeEntry,
        cursorSigningKey: options.cursorSigningKey,
      })
      return context.json(envelope, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translateResourceError(error, 'time entry', principal)
    }
  })

  api.post('/time-entries', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const input = createInput(await readObjectBody(context))
      assertMayNameUser(principal, input.userId)
      const entry = await options.repository.createTimeEntry(
        principal,
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
      return translateResourceError(error, 'time entry', principal)
    }
  })

  api.get('/time-entries/:id', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.getTimeEntry(
        principal,
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
      return translateResourceError(error, 'time entry', principal)
    }
  })

  api.patch('/time-entries/:id', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.updateTimeEntry(
        principal,
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
      return translateResourceError(error, 'time entry', principal)
    }
  })

  api.delete('/time-entries/:id', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.deleteTimeEntry(
        principal,
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
      return translateResourceError(error, 'time entry', principal)
    }
  })

  api.post('/time-entries/:id/stop', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.stopTimeEntry(
        principal,
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
      return translateResourceError(error, 'time entry', principal)
    }
  })

  api.post('/time-entries/:id/restart', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const entry = await options.repository.restartTimeEntry(
        principal,
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
      return translateResourceError(error, 'time entry', principal)
    }
  })
}
