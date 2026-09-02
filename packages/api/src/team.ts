import {
  canViewMoneyField,
  reminderDays,
  teamProfiles,
  TeamError,
  type ReminderDay,
  type TeamCommandKind,
  type TeamCommandReceipt,
  type TeamNamedRelation,
  type TeamNotificationPatch,
  type TeamPersonPatch,
  type TeamPersonRecord,
  type TeamPersonSummary,
  type TeamRepository,
  type TeamViewer,
  type UserProfile,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { requireApiScope, requireSessionPrincipal } from './auth.js'
import type { ApiContext, UserPrincipal } from './context.js'
import { ApiError, readJsonBody, validationError, type FieldError } from './errors.js'
import { cursorPage } from './pagination.js'
import { queryDate, resourceId, strictSearchParams } from './resources/support.js'

export interface TeamRouteOptions {
  repository: TeamRepository
  cursorSigningKey: Uint8Array
  isTeamModuleEnabled(): Promise<boolean>
  clock?: () => string
}

const idempotencyPattern = /^[A-Za-z0-9._:-]{1,128}$/u
const canonicalTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u
const canonicalDate = /^\d{4}-\d{2}-\d{2}$/u

const isCanonicalDate = (value: string): boolean => {
  if (!canonicalDate.test(value)) return false
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
}

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

const viewer = (principal: Readonly<UserPrincipal>): TeamViewer => ({
  userId: principal.userId,
  profile: principal.profile,
  managerGrants: principal.managerGrants,
})

const requireEnabled = async (options: Readonly<Required<TeamRouteOptions>>): Promise<void> => {
  if (await options.isTeamModuleEnabled()) return
  throw new ApiError({
    status: 403,
    code: 'module_disabled',
    message: 'The Team module is not enabled for this organization.',
  })
}

const translate = (error: unknown): never => {
  if (!(error instanceof TeamError)) throw error
  if (error.code === 'not_found') {
    throw new ApiError({ status: 404, code: 'not_found', message: error.message })
  }
  if (error.code === 'forbidden') {
    throw new ApiError({ status: 403, code: 'profile_forbidden', message: error.message })
  }
  if (error.code === 'state_conflict' || error.code === 'command_id_reused') {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  throw validationError([{ field: 'body', code: error.code, message: error.message }])
}

const snakeNotification = (value: Readonly<TeamPersonRecord['notifications']>) => ({
  daily_reminder_enabled: value.dailyReminderEnabled,
  reminder_time: value.reminderTime,
  reminder_days: [...value.reminderDays],
  channels: {
    email: value.emailEnabled,
    desktop: value.desktopEnabled,
    slack: value.slackEnabled,
  },
  include_in_team_reminders: value.includeInTeamReminders,
  weekly_digest: value.weeklyDigest,
  notify_project_deleted: value.notifyProjectDeleted,
  updated_at: value.updatedAt,
})

const snakeRelation = (value: Readonly<TeamNamedRelation>) => ({
  id: value.id,
  name: value.name,
})

const serializeSummary = (person: Readonly<TeamPersonSummary>) => ({
  id: person.id,
  first_name: person.firstName,
  last_name: person.lastName,
  email: person.email,
  avatar_url: person.avatarUrl,
  profile: person.profile,
  is_owner: person.isOwner,
  is_contractor: person.isContractor,
  is_active: person.isActive,
  weekly_capacity: person.weeklyCapacity,
  total_seconds: person.totalSeconds,
  billable_seconds: person.billableSeconds,
  nonbillable_seconds: person.nonbillableSeconds,
  utilization_ppm: person.utilizationPpm,
  running: person.running,
})

const serializePerson = (
  person: Readonly<TeamPersonRecord>,
  principal: Readonly<UserPrincipal>,
) => ({
  id: person.id,
  first_name: person.firstName,
  last_name: person.lastName,
  email: person.email,
  telephone: person.telephone,
  employee_id: person.employeeId,
  timezone: person.timezone,
  is_contractor: person.isContractor,
  is_active: person.isActive,
  has_access_to_all_future_projects: person.hasAccessToAllFutureProjects,
  weekly_capacity: person.weeklyCapacity,
  profile: person.profile,
  is_owner: person.isOwner,
  avatar_url: person.avatarUrl,
  version: person.version,
  created_at: person.createdAt,
  updated_at: person.updatedAt,
  roles: person.roles.map(snakeRelation),
  departments: person.departments.map(snakeRelation),
  project_assignments: person.projectAssignments.map((assignment) => ({
    id: assignment.id,
    project_id: assignment.projectId,
    project_name: assignment.projectName,
    project_code: assignment.projectCode,
    client_id: assignment.clientId,
    client_name: assignment.clientName,
    is_active: assignment.isActive,
    is_project_manager: assignment.isProjectManager,
    use_default_rates: assignment.useDefaultRates,
    ...(canViewMoneyField(principal, 'billable_rate')
      ? { hourly_rate_cents: assignment.hourlyRateCents }
      : {}),
    budget_seconds: assignment.budgetSeconds,
    updated_at: assignment.updatedAt,
  })),
  ...(canViewMoneyField(principal, 'billable_rate')
    ? {
        billable_rates: person.billableRates.map((rate) => ({
          id: rate.id,
          user_id: rate.userId,
          amount_cents: rate.amountCents,
          start_date: rate.startDate,
          end_date: rate.endDate,
          created_at: rate.createdAt,
          updated_at: rate.updatedAt,
        })),
      }
    : {}),
  ...(canViewMoneyField(principal, 'cost_rate')
    ? {
        cost_rates: person.costRates.map((rate) => ({
          id: rate.id,
          user_id: rate.userId,
          amount_cents: rate.amountCents,
          start_date: rate.startDate,
          end_date: rate.endDate,
          created_at: rate.createdAt,
          updated_at: rate.updatedAt,
        })),
      }
    : {}),
  notifications: snakeNotification(person.notifications),
})

const serializeReceipt = (receipt: Readonly<TeamCommandReceipt>) => ({
  target_user_id: receipt.targetUserId,
  version: receipt.version,
  resource_id: receipt.resourceId,
  occurred_at: receipt.occurredAt,
})

const objectBody = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<Record<string, unknown>> => {
  const body = await readJsonBody<unknown>(context)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([{ field: 'body', code: 'invalid', message: 'body must be an object' }])
  }
  return body as Record<string, unknown>
}

const commandId = <Bindings extends object>(context: Context<ApiContext<Bindings>>): string => {
  const value = context.req.header('idempotency-key')
  if (value === undefined || !idempotencyPattern.test(value)) {
    throw validationError([
      {
        field: 'Idempotency-Key',
        code: 'invalid',
        message: 'Idempotency-Key must use 1-128 safe identifier characters',
      },
    ])
  }
  return value
}

const expectedVersion = (body: Record<string, unknown>, errors: FieldError[]): number => {
  const value = body.expected_version
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    errors.push({
      field: 'expected_version',
      code: 'invalid_integer',
      message: 'expected_version must be a non-negative safe integer',
    })
  }
  return value as number
}

const noUnknown = (
  body: Readonly<Record<string, unknown>>,
  accepted: ReadonlySet<string>,
  errors: FieldError[],
): void => {
  for (const field of Object.keys(body)) {
    if (!accepted.has(field)) {
      errors.push({ field, code: 'unknown', message: `${field} is not accepted` })
    }
  }
}

const nonblank = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  errors: FieldError[],
): string | undefined => {
  if (!Object.hasOwn(body, field)) return undefined
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ field, code: 'invalid_string', message: `${field} must be a non-empty string` })
    return undefined
  }
  return value.trim()
}

const nullableText = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  errors: FieldError[],
): string | null | undefined => {
  if (!Object.hasOwn(body, field)) return undefined
  const value = body[field]
  if (value !== null && typeof value !== 'string') {
    errors.push({ field, code: 'invalid_string', message: `${field} must be a string or null` })
    return undefined
  }
  return value === null || value.trim() === '' ? null : value.trim()
}

const booleanField = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  errors: FieldError[],
): boolean | undefined => {
  if (!Object.hasOwn(body, field)) return undefined
  const value = body[field]
  if (typeof value !== 'boolean') {
    errors.push({ field, code: 'invalid_boolean', message: `${field} must be a boolean` })
    return undefined
  }
  return value
}

const idArray = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  errors: FieldError[],
): number[] | undefined => {
  if (!Object.hasOwn(body, field)) return undefined
  const value = body[field]
  if (
    !Array.isArray(value) ||
    !value.every((item) => Number.isSafeInteger(item) && item > 0) ||
    new Set(value).size !== value.length
  ) {
    errors.push({
      field,
      code: 'invalid_array',
      message: `${field} must contain distinct positive safe integers`,
    })
    return undefined
  }
  return value as number[]
}

const parsePersonPatch = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<{ expectedVersion: number; patch: TeamPersonPatch }> => {
  const body = await objectBody(context)
  const accepted = new Set([
    'expected_version', 'first_name', 'last_name', 'telephone', 'employee_id', 'timezone',
    'is_contractor', 'is_active', 'has_access_to_all_future_projects', 'weekly_capacity',
    'profile', 'role_ids', 'department_ids',
  ])
  const errors: FieldError[] = []
  noUnknown(body, accepted, errors)
  const version = expectedVersion(body, errors)
  const firstName = nonblank(body, 'first_name', errors)
  const lastName = nonblank(body, 'last_name', errors)
  const timezone = nonblank(body, 'timezone', errors)
  if (timezone !== undefined && !isTimeZone(timezone)) {
    errors.push({ field: 'timezone', code: 'invalid_timezone', message: 'timezone must be an IANA time zone' })
  }
  const telephone = nullableText(body, 'telephone', errors)
  const employeeId = nullableText(body, 'employee_id', errors)
  const isContractor = booleanField(body, 'is_contractor', errors)
  const isActive = booleanField(body, 'is_active', errors)
  const future = booleanField(body, 'has_access_to_all_future_projects', errors)
  let weeklyCapacity: number | undefined
  if (Object.hasOwn(body, 'weekly_capacity')) {
    const value = body.weekly_capacity
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      errors.push({
        field: 'weekly_capacity',
        code: 'invalid_integer',
        message: 'weekly_capacity must be a non-negative safe integer',
      })
    } else weeklyCapacity = value as number
  }
  let profile: UserProfile | undefined
  if (Object.hasOwn(body, 'profile')) {
    if (typeof body.profile !== 'string' || !teamProfiles.includes(body.profile as UserProfile)) {
      errors.push({ field: 'profile', code: 'invalid_enum', message: 'profile is not accepted' })
    } else profile = body.profile as UserProfile
  }
  const roleIds = idArray(body, 'role_ids', errors)
  const departmentIds = idArray(body, 'department_ids', errors)
  if (Object.keys(body).length === 1 && Object.hasOwn(body, 'expected_version')) {
    errors.push({ field: 'body', code: 'empty', message: 'at least one change is required' })
  }
  if (errors.length > 0) throw validationError(errors)
  return {
    expectedVersion: version,
    patch: {
      ...(firstName === undefined ? {} : { firstName }),
      ...(lastName === undefined ? {} : { lastName }),
      ...(telephone === undefined ? {} : { telephone }),
      ...(employeeId === undefined ? {} : { employeeId }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(isContractor === undefined ? {} : { isContractor }),
      ...(isActive === undefined ? {} : { isActive }),
      ...(future === undefined ? {} : { hasAccessToAllFutureProjects: future }),
      ...(weeklyCapacity === undefined ? {} : { weeklyCapacity }),
      ...(profile === undefined ? {} : { profile }),
      ...(roleIds === undefined ? {} : { roleIds }),
      ...(departmentIds === undefined ? {} : { departmentIds }),
    },
  }
}

const requirePersonWriter = (principal: Readonly<UserPrincipal>): void => {
  if (
    principal.profile !== 'people_admin' &&
    principal.profile !== 'executive_manager' &&
    principal.profile !== 'administrator'
  ) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'The acting user profile cannot manage people.',
    })
  }
}

const command = (
  id: string,
  kind: TeamCommandKind,
  targetUserId: number,
  expected: number,
  principal: Readonly<UserPrincipal>,
  occurredAt: string,
) => ({
  commandId: id,
  commandKind: kind,
  targetUserId,
  actorUserId: principal.userId,
  expectedVersion: expected,
  occurredAt,
})

const ensureVisible = async (
  options: Readonly<Required<TeamRouteOptions>>,
  principal: Readonly<UserPrincipal>,
  userId: number,
): Promise<TeamPersonRecord> => {
  const person = await options.repository.get(viewer(principal), userId)
  if (person === null) {
    throw new ApiError({ status: 404, code: 'not_found', message: 'The person does not exist.' })
  }
  return person
}

const receiptEnvelope = (receipt: Readonly<TeamCommandReceipt>) => ({
  data: serializeReceipt(receipt),
  links: { self: `/api/v1/team/people/${receipt.targetUserId}` },
})

export const installTeamRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  supplied: TeamRouteOptions,
): void => {
  const options: Required<TeamRouteOptions> = {
    ...supplied,
    clock: supplied.clock ?? (() => new Date().toISOString()),
  }

  api.get('/team/status', async (context) => {
    requireApiScope(context, 'team:read')
    return context.json(
      {
        data: { enabled: await options.isTeamModuleEnabled() },
        links: { self: '/api/v1/team/status' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/team/people', async (context) => {
    requireApiScope(context, 'team:read')
    await requireEnabled(options)
    const url = new URL(context.req.url)
    const params = strictSearchParams(url, new Set(['cursor', 'per_page', 'from', 'to', 'is_active']))
    const errors: FieldError[] = []
    const from = queryDate(params, 'from', errors)
    const to = queryDate(params, 'to', errors)
    if (from === undefined && !params.has('from')) {
      errors.push({ field: 'from', code: 'required', message: 'from is required' })
    }
    if (to === undefined && !params.has('to')) {
      errors.push({ field: 'to', code: 'required', message: 'to is required' })
    }
    if (from !== undefined && to !== undefined && from > to) {
      errors.push({ field: 'to', code: 'inverted_range', message: 'to must be on or after from' })
    }
    let isActive: boolean | undefined
    const active = params.get('is_active')
    if (active !== undefined) {
      if (active !== 'true' && active !== 'false') {
        errors.push({ field: 'is_active', code: 'invalid_boolean', message: 'is_active must be true or false' })
      } else isActive = active === 'true'
    }
    if (errors.length > 0) throw validationError(errors)
    const principal = context.get('principal')
    const filter = { from: from!, to: to!, ...(isActive === undefined ? {} : { isActive }) }
    try {
      return context.json(
        await cursorPage({
          requestUrl: url,
          cursorSigningKey: options.cursorSigningKey,
          viewer: principal,
          serializer: serializeSummary,
          source: {
            highWatermark: () => options.repository.highWatermark(viewer(principal), filter),
            list: (window) => options.repository.list(viewer(principal), filter, window),
          },
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/team/people/:id', async (context) => {
    requireApiScope(context, 'team:read')
    await requireEnabled(options)
    const principal = context.get('principal')
    try {
      const person = await ensureVisible(options, principal, resourceId(context.req.param('id'), 'person'))
      return context.json({
        data: serializePerson(person, principal),
        links: { self: `/api/v1/team/people/${person.id}` },
      }, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/team/catalog', async (context) => {
    requireApiScope(context, 'team:read')
    await requireEnabled(options)
    const principal = context.get('principal')
    const canManage = ['people_admin', 'executive_manager', 'administrator'].includes(principal.profile)
    const [roles, departments, projects] = await Promise.all([
      options.repository.listRoles(),
      options.repository.listDepartments(),
      canManage ? options.repository.listAssignableProjects() : Promise.resolve([]),
    ])
    return context.json(
      {
        data: {
          roles: roles.map(snakeRelation),
          departments: departments.map(snakeRelation),
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            code: project.code,
            client_id: project.clientId,
            client_name: project.clientName,
            is_active: project.isActive,
          })),
        },
        links: { self: '/api/v1/team/catalog' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.patch('/team/people/:id', async (context) => {
    const principal = requireSessionPrincipal(context)
    requirePersonWriter(principal)
    await requireEnabled(options)
    const userId = resourceId(context.req.param('id'), 'person')
    const person = await ensureVisible(options, principal, userId)
    const parsed = await parsePersonPatch(context)
    if (parsed.patch.profile !== undefined && principal.profile !== 'administrator') {
      throw new ApiError({ status: 403, code: 'profile_forbidden', message: 'Only an administrator can change permission profiles.' })
    }
    if (person.isOwner && (parsed.patch.profile !== undefined || parsed.patch.isActive === false)) {
      throw new ApiError({ status: 409, code: 'owner_immutable', message: 'The organization owner profile and active status cannot be changed.' })
    }
    try {
      const receipt = await options.repository.updatePerson(
        command(commandId(context), 'person.update', userId, parsed.expectedVersion, principal, options.clock()),
        parsed.patch,
      )
      return context.json(receiptEnvelope(receipt))
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/team/people/:id/project-assignments/replace', async (context) => {
    const principal = requireSessionPrincipal(context)
    requirePersonWriter(principal)
    await requireEnabled(options)
    const userId = resourceId(context.req.param('id'), 'person')
    await ensureVisible(options, principal, userId)
    const body = await objectBody(context)
    const errors: FieldError[] = []
    noUnknown(body, new Set(['expected_version', 'assignments']), errors)
    const version = expectedVersion(body, errors)
    const values = body.assignments
    const assignments: Array<{ projectId: number; isProjectManager: boolean }> = []
    if (!Array.isArray(values)) {
      errors.push({ field: 'assignments', code: 'invalid_array', message: 'assignments must be an array' })
    } else {
      for (const [index, value] of values.entries()) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          errors.push({ field: `assignments.${index}`, code: 'invalid', message: 'assignment must be an object' })
          continue
        }
        const entry = value as Record<string, unknown>
        if (
          Object.keys(entry).some((field) => field !== 'project_id' && field !== 'is_project_manager') ||
          !Number.isSafeInteger(entry.project_id) || (entry.project_id as number) < 1 ||
          typeof entry.is_project_manager !== 'boolean'
        ) {
          errors.push({ field: `assignments.${index}`, code: 'invalid', message: 'assignment requires project_id and is_project_manager' })
          continue
        }
        assignments.push({ projectId: entry.project_id as number, isProjectManager: entry.is_project_manager })
      }
      if (new Set(assignments.map(({ projectId }) => projectId)).size !== assignments.length) {
        errors.push({ field: 'assignments', code: 'duplicate', message: 'each project may be assigned once' })
      }
    }
    if (errors.length > 0) throw validationError(errors)
    try {
      const receipt = await options.repository.replaceAssignments(
        command(commandId(context), 'person.assignments.replace', userId, version, principal, options.clock()),
        assignments,
      )
      return context.json(receiptEnvelope(receipt))
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/team/people/:id/notifications', async (context) => {
    const principal = requireSessionPrincipal(context)
    requirePersonWriter(principal)
    await requireEnabled(options)
    const userId = resourceId(context.req.param('id'), 'person')
    await ensureVisible(options, principal, userId)
    const body = await objectBody(context)
    const errors: FieldError[] = []
    noUnknown(body, new Set([
      'expected_version', 'daily_reminder_enabled', 'reminder_time', 'reminder_days',
      'channels', 'include_in_team_reminders', 'weekly_digest', 'notify_project_deleted',
    ]), errors)
    const version = expectedVersion(body, errors)
    const daily = booleanField(body, 'daily_reminder_enabled', errors)
    const include = booleanField(body, 'include_in_team_reminders', errors)
    const weekly = booleanField(body, 'weekly_digest', errors)
    const deleted = booleanField(body, 'notify_project_deleted', errors)
    const time = body.reminder_time
    if (time !== null && (typeof time !== 'string' || !canonicalTime.test(time))) {
      errors.push({ field: 'reminder_time', code: 'invalid_time', message: 'reminder_time must be HH:MM or null' })
    }
    const days = body.reminder_days
    if (
      !Array.isArray(days) ||
      !days.every((day) => typeof day === 'string' && reminderDays.includes(day as ReminderDay)) ||
      new Set(days).size !== days.length
    ) {
      errors.push({ field: 'reminder_days', code: 'invalid_array', message: 'reminder_days must contain distinct weekdays' })
    }
    const channels = body.channels
    const channel = typeof channels === 'object' && channels !== null && !Array.isArray(channels)
      ? channels as Record<string, unknown>
      : null
    if (
      channel === null || Object.keys(channel).some((field) => !['email', 'desktop', 'slack'].includes(field)) ||
      typeof channel?.email !== 'boolean' || typeof channel.desktop !== 'boolean' || typeof channel.slack !== 'boolean'
    ) {
      errors.push({ field: 'channels', code: 'invalid', message: 'channels requires email, desktop, and slack booleans' })
    } else if (channel.slack) {
      errors.push({ field: 'channels.slack', code: 'unavailable', message: 'Slack reminders require a configured Slack connector.' })
    }
    if (daily === true && (time === null || !Array.isArray(days) || days.length === 0 || channel === null || (!channel.email && !channel.desktop && !channel.slack))) {
      errors.push({ field: 'daily_reminder_enabled', code: 'incomplete', message: 'Daily reminders require a time, at least one day, and at least one channel.' })
    }
    if ([daily, include, weekly, deleted].some((value) => value === undefined)) {
      errors.push({ field: 'body', code: 'required', message: 'All notification preference fields are required.' })
    }
    if (errors.length > 0) throw validationError(errors)
    const patch: TeamNotificationPatch = {
      dailyReminderEnabled: daily!,
      reminderTime: time as string | null,
      reminderDays: days as ReminderDay[],
      emailEnabled: channel!.email as boolean,
      desktopEnabled: channel!.desktop as boolean,
      slackEnabled: false,
      includeInTeamReminders: include!,
      weeklyDigest: weekly!,
      notifyProjectDeleted: deleted!,
    }
    try {
      const receipt = await options.repository.updateNotifications(
        command(commandId(context), 'person.notifications.update', userId, version, principal, options.clock()),
        patch,
      )
      return context.json(receiptEnvelope(receipt))
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/team/people/:id/rates', async (context) => {
    const principal = requireSessionPrincipal(context)
    await requireEnabled(options)
    const userId = resourceId(context.req.param('id'), 'person')
    await ensureVisible(options, principal, userId)
    const body = await objectBody(context)
    const errors: FieldError[] = []
    noUnknown(body, new Set(['expected_version', 'kind', 'amount_cents', 'start_date']), errors)
    const version = expectedVersion(body, errors)
    const kind = body.kind
    if (kind !== 'billable' && kind !== 'cost') {
      errors.push({ field: 'kind', code: 'invalid_enum', message: 'kind must be billable or cost' })
    }
    if (!Number.isSafeInteger(body.amount_cents) || (body.amount_cents as number) < 0) {
      errors.push({ field: 'amount_cents', code: 'invalid_integer', message: 'amount_cents must be a non-negative safe integer' })
    }
    const startDate = body.start_date
    if (startDate !== null && (typeof startDate !== 'string' || !isCanonicalDate(startDate) || startDate > options.clock().slice(0, 10))) {
      errors.push({ field: 'start_date', code: 'invalid_date', message: 'start_date must be a real date that is not in the future, or null' })
    }
    const canWrite = principal.profile === 'administrator' ||
      (kind === 'billable' && principal.profile === 'project_manager' && principal.managerGrants.includes('billable_rates_manager'))
    if (!canWrite) {
      throw new ApiError({ status: 403, code: 'profile_forbidden', message: 'The acting user profile cannot change this rate.' })
    }
    if (errors.length > 0) throw validationError(errors)
    const commandKind = kind === 'billable' ? 'person.billable_rate.append' : 'person.cost_rate.append'
    try {
      const receipt = await options.repository.appendRate(
        command(commandId(context), commandKind, userId, version, principal, options.clock()),
        { kind: kind as 'billable' | 'cost', amountCents: body.amount_cents as number, startDate: startDate as string | null },
      )
      return context.json(receiptEnvelope(receipt), 201)
    } catch (error) {
      return translate(error)
    }
  })
}
