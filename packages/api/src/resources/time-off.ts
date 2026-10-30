import { expectedPlanningVersion } from './planning-revisions.js'
import {
  TimeOffConflictError,
  TimeOffNotFoundError,
  TimeOffOverlapError,
  timeOffKinds,
  type TeamViewer,
  type TimeOffKind,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireApiScope } from '../auth.js'
import type { ApiContext } from '../context.js'
import { ApiError, type FieldError } from '../errors.js'
import { cursorPage, type CursorSource } from '../pagination.js'
import {
  assertFields,
  notFound,
  optionalDate,
  queryDate,
  queryPositiveInteger,
  readObjectBody,
  requiredPositiveInteger,
  resourceId,
  strictSearchParams,
  translateResourceError,
  unknownFieldErrors,
} from './support.js'
import type { TrackedResourceClock } from './tracked-repository.js'

/**
 * Time off (issue 1007, slice 3): days a person is away, entered by an
 * administrator, that reduce the capacity the capacity view counts as
 * available. There is no request or approval step. Administrators, executive
 * managers and project managers write (a project manager only for the people
 * they manage); everyone else reads only their own.
 */

export interface TimeOffRecord {
  version: number
  id: number
  userId: number
  startDate: string
  endDate: string
  kind: TimeOffKind
  secondsPerDay: number | null
  createdAt: string
  updatedAt: string
}

export interface TimeOffFilters {
  userId?: number
  from?: string
  to?: string
}

export interface CreateTimeOffRequest {
  userId: number
  startDate: string
  endDate: string
  kind: TimeOffKind
  secondsPerDay: number | null
}

export interface UpdateTimeOffRequest {
  version?: number
  startDate?: string
  endDate?: string
  kind?: TimeOffKind
  secondsPerDay?: number | null
}

export interface TimeOffRepository {
  entries(
    viewer: Readonly<TeamViewer>,
    filters: Readonly<TimeOffFilters>,
  ): CursorSource<TimeOffRecord>
  get(viewer: Readonly<TeamViewer>, id: number): Promise<TimeOffRecord>
  create(
    viewer: Readonly<TeamViewer>,
    input: Readonly<CreateTimeOffRequest>,
    now: string,
  ): Promise<TimeOffRecord>
  update(
    viewer: Readonly<TeamViewer>,
    id: number,
    patch: Readonly<UpdateTimeOffRequest>,
    now: string,
  ): Promise<TimeOffRecord>
  delete(viewer: Readonly<TeamViewer>, id: number, now: string, version?: number): Promise<TimeOffRecord>
}

export interface TimeOffRouteOptions {
  repository: TimeOffRepository
  clock: TrackedResourceClock
  cursorSigningKey: Uint8Array
}

interface TimeOffOutput {
  version: number
  id: number
  user_id: number
  start_date: string
  end_date: string
  kind: TimeOffKind
  seconds_per_day: number | null
  created_at: string
  updated_at: string
}

export const serializeTimeOff = (entry: Readonly<TimeOffRecord>): TimeOffOutput => ({
  id: entry.id,
  version: entry.version,
  user_id: entry.userId,
  start_date: entry.startDate,
  end_date: entry.endDate,
  kind: entry.kind,
  seconds_per_day: entry.secondsPerDay,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
})

const viewerOf = (principal: {
  userId: number
  profile: TeamViewer['profile']
  managerGrants: readonly string[]
}): TeamViewer => ({
  userId: principal.userId,
  profile: principal.profile,
  managerGrants: principal.managerGrants,
})

const listKeys = new Set(['cursor', 'per_page', 'user_id', 'from', 'to'])
const createKeys = new Set(['user_id', 'start_date', 'end_date', 'kind', 'seconds_per_day'])
const updateKeys = new Set(['version', 'start_date', 'end_date', 'kind', 'seconds_per_day'])

const listFilters = (url: URL): TimeOffFilters => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const userId = queryPositiveInteger(params, 'user_id', errors)
  const from = queryDate(params, 'from', errors)
  const to = queryDate(params, 'to', errors)
  if (from !== undefined && to !== undefined && from > to) {
    errors.push({ field: 'to', code: 'invalid_range', message: 'to must not precede from' })
  }
  assertFields(errors)
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  }
}

const requiredDate = (
  body: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): string | undefined => {
  if (!Object.hasOwn(body, field)) {
    errors.push({ field, code: 'required', message: `${field} is required` })
    return undefined
  }
  return optionalDate(body, field, errors)
}

const kindOf = (
  body: Record<string, unknown>,
  required: boolean,
  errors: FieldError[],
): TimeOffKind | undefined => {
  if (!Object.hasOwn(body, 'kind')) {
    if (required) errors.push({ field: 'kind', code: 'required', message: 'kind is required' })
    return undefined
  }
  const value = body.kind
  if (typeof value !== 'string' || !(timeOffKinds as readonly string[]).includes(value)) {
    errors.push({
      field: 'kind',
      code: 'unsupported',
      message: `kind must be one of ${timeOffKinds.join(', ')}`,
    })
    return undefined
  }
  return value as TimeOffKind
}

/** Absent is undefined; null is a whole day; the bounds are the domain's. */
const secondsPerDayOf = (
  body: Record<string, unknown>,
  errors: FieldError[],
): number | null | undefined => {
  if (!Object.hasOwn(body, 'seconds_per_day')) return undefined
  const value = body.seconds_per_day
  if (value === null) return null
  if (!Number.isSafeInteger(value)) {
    errors.push({
      field: 'seconds_per_day',
      code: 'invalid_integer',
      message: 'seconds_per_day must be a whole number of seconds or null',
    })
    return undefined
  }
  return value as number
}

const createInput = (body: Record<string, unknown>): CreateTimeOffRequest => {
  const errors = unknownFieldErrors(body, createKeys)
  const userId = requiredPositiveInteger(body, 'user_id', errors)
  const startDate = requiredDate(body, 'start_date', errors)
  const endDate = requiredDate(body, 'end_date', errors)
  const kind = kindOf(body, true, errors)
  const secondsPerDay = secondsPerDayOf(body, errors)
  assertFields(errors)
  return {
    userId: userId!,
    startDate: startDate!,
    endDate: endDate!,
    kind: kind!,
    secondsPerDay: secondsPerDay ?? null,
  }
}

const updateInput = (body: Record<string, unknown>): UpdateTimeOffRequest => {
  const errors = unknownFieldErrors(body, updateKeys)
  const startDate = optionalDate(body, 'start_date', errors)
  const endDate = optionalDate(body, 'end_date', errors)
  const kind = kindOf(body, false, errors)
  const secondsPerDay = secondsPerDayOf(body, errors)
  if (Object.keys(body).every(key => key === 'version')) {
    errors.push({ field: 'body', code: 'empty', message: 'at least one field is required' })
  }
  assertFields(errors)
  return {
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(secondsPerDay !== undefined ? { secondsPerDay } : {}),
  }
}

/** Time-off-specific failures; the rest are the shared resource errors. */
const translateTimeOffError = (error: unknown): never => {
  if (error instanceof TimeOffNotFoundError) throw notFound('time off')
  if (error instanceof TimeOffConflictError) {
    throw new ApiError({ status: 409, code: error.code, message: error.message,
      ...(error.currentVersion === undefined || error.current === undefined ? {} : {
        revisionConflict: { currentVersion: error.currentVersion, current: serializeTimeOff(error.current as TimeOffRecord) },
      }),
    })
  }
  if (error instanceof TimeOffOverlapError) {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  return translateResourceError(error, 'time off')
}

const selfLink = (id: number) => `/api/v1/time-off/${id}`

export const installTimeOffRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: TimeOffRouteOptions,
): void => {
  api.get('/time-off', async (context) => {
    requireApiScope(context, 'schedule:read')
    const principal = context.get('principal')
    try {
      const url = new URL(context.req.url)
      const envelope = await cursorPage({
        requestUrl: url,
        source: options.repository.entries(viewerOf(principal), listFilters(url)),
        viewer: principal,
        serializer: serializeTimeOff,
        cursorSigningKey: options.cursorSigningKey,
      })
      return context.json(envelope, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translateTimeOffError(error)
    }
  })

  api.post('/time-off', async (context) => {
    requireApiScope(context, 'schedule:write')
    try {
      const created = await options.repository.create(
        viewerOf(context.get('principal')),
        createInput(await readObjectBody(context)),
        options.clock.now().instant,
      )
      return context.json(
        { data: serializeTimeOff(created), links: { self: selfLink(created.id) } },
        201,
        { 'cache-control': 'no-store', location: selfLink(created.id) },
      )
    } catch (error) {
      return translateTimeOffError(error)
    }
  })

  api.get('/time-off/:id', async (context) => {
    requireApiScope(context, 'schedule:read')
    try {
      const id = resourceId(context.req.param('id'), 'time off')
      const entry = await options.repository.get(viewerOf(context.get('principal')), id)
      return context.json({ data: serializeTimeOff(entry), links: { self: selfLink(id) } }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return translateTimeOffError(error)
    }
  })

  api.patch('/time-off/:id', async (context) => {
    requireApiScope(context, 'schedule:write')
    try {
      const id = resourceId(context.req.param('id'), 'time off')
      const body = await readObjectBody(context)
      const now = options.clock.now().instant
      const version = expectedPlanningVersion(body, now, (name, value) => context.header(name, value))
      const entry = await options.repository.update(
        viewerOf(context.get('principal')),
        id,
        { ...updateInput(body), ...(version === undefined ? {} : { version }) },
        now,
      )
      return context.json({ data: serializeTimeOff(entry), links: { self: selfLink(id) } }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return translateTimeOffError(error)
    }
  })

  api.delete('/time-off/:id', async (context) => {
    requireApiScope(context, 'schedule:write')
    try {
      const id = resourceId(context.req.param('id'), 'time off')
      const body = await readObjectBody(context, { allowEmptyObject: true })
      assertFields(unknownFieldErrors(body, new Set(['version'])))
      const now = options.clock.now().instant
      const version = expectedPlanningVersion(body, now, (name, value) => context.header(name, value))
      const entry = await options.repository.delete(
        viewerOf(context.get('principal')),
        id,
        now,
        version,
      )
      return context.json({ data: serializeTimeOff(entry), links: { self: selfLink(id) } }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return translateTimeOffError(error)
    }
  })
}
