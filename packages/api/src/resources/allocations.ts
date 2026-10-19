import {
  AllocationConflictError,
  AllocationNotFoundError,
  AllocationOverlapError,
  type AllocationWeekStartDay,
  type TeamViewer,
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
import { installTimeOffRoutes, type TimeOffRepository } from './time-off.js'

/**
 * Resource planning (issue 1007, slices 1 and 2): dated allocations of planned
 * hours per week, and the read-only person-by-week capacity view.
 *
 * A plan is not work. Nothing here reads or writes a time entry, a rate or an
 * invoice. Administrators, executive managers and project managers write (the
 * `schedule:write` ceiling, and a project manager only inside the people and
 * projects they manage); everyone else reads only their own. Over-allocation is
 * a flag in the capacity view and never a refusal.
 */

export interface AllocationRecord {
  id: number
  userId: number
  projectId: number
  startDate: string
  endDate: string
  plannedSecondsPerWeek: number
  createdAt: string
  updatedAt: string
}

export interface AllocationFilters {
  userId?: number
  projectId?: number
  from?: string
  to?: string
}

export interface CreateAllocationRequest {
  userId: number
  projectId: number
  startDate: string
  endDate: string
  plannedSecondsPerWeek: number
}

export interface UpdateAllocationRequest {
  startDate?: string
  endDate?: string
  plannedSecondsPerWeek?: number
}

export interface CapacityWeekRecord {
  weekStart: string
  plannedSeconds: number
  timeOffSeconds: number
  availableCapacitySeconds: number
  trackedSeconds: number
  overAllocated: boolean
}

export interface CapacityPersonRecord {
  userId: number
  firstName: string
  lastName: string
  weeklyCapacitySeconds: number
  weeks: CapacityWeekRecord[]
}

export interface CapacityReportRecord {
  weekStartDay: AllocationWeekStartDay
  weeks: string[]
  people: CapacityPersonRecord[]
}

export interface AllocationRepository {
  /** Administrator-entered time off (issue 1007, slice 3). */
  timeOff: TimeOffRepository
  allocations(
    viewer: Readonly<TeamViewer>,
    filters: Readonly<AllocationFilters>,
  ): CursorSource<AllocationRecord>
  get(viewer: Readonly<TeamViewer>, id: number): Promise<AllocationRecord>
  create(
    viewer: Readonly<TeamViewer>,
    input: Readonly<CreateAllocationRequest>,
    now: string,
  ): Promise<AllocationRecord>
  update(
    viewer: Readonly<TeamViewer>,
    id: number,
    patch: Readonly<UpdateAllocationRequest>,
    now: string,
  ): Promise<AllocationRecord>
  delete(viewer: Readonly<TeamViewer>, id: number, now: string): Promise<AllocationRecord>
  capacity(
    viewer: Readonly<TeamViewer>,
    request: Readonly<{ from: string; to: string }>,
  ): Promise<CapacityReportRecord>
}

export interface AllocationRouteOptions {
  repository: AllocationRepository
  clock: TrackedResourceClock
  cursorSigningKey: Uint8Array
}

interface AllocationOutput {
  id: number
  user_id: number
  project_id: number
  start_date: string
  end_date: string
  planned_seconds_per_week: number
  created_at: string
  updated_at: string
}

export const serializeAllocation = (allocation: Readonly<AllocationRecord>): AllocationOutput => ({
  id: allocation.id,
  user_id: allocation.userId,
  project_id: allocation.projectId,
  start_date: allocation.startDate,
  end_date: allocation.endDate,
  planned_seconds_per_week: allocation.plannedSecondsPerWeek,
  created_at: allocation.createdAt,
  updated_at: allocation.updatedAt,
})

export const serializeCapacity = (report: Readonly<CapacityReportRecord>) => ({
  week_start_day: report.weekStartDay,
  weeks: report.weeks,
  people: report.people.map((person) => ({
    user_id: person.userId,
    first_name: person.firstName,
    last_name: person.lastName,
    weekly_capacity_seconds: person.weeklyCapacitySeconds,
    weeks: person.weeks.map((week) => ({
      week_start: week.weekStart,
      planned_seconds: week.plannedSeconds,
      time_off_seconds: week.timeOffSeconds,
      available_capacity_seconds: week.availableCapacitySeconds,
      tracked_seconds: week.trackedSeconds,
      over_allocated: week.overAllocated,
    })),
  })),
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

const listKeys = new Set(['cursor', 'per_page', 'user_id', 'project_id', 'from', 'to'])
const capacityKeys = new Set(['from', 'to'])
const createKeys = new Set(['user_id', 'project_id', 'start_date', 'end_date', 'planned_seconds_per_week'])
const updateKeys = new Set(['start_date', 'end_date', 'planned_seconds_per_week'])

const listFilters = (url: URL): AllocationFilters => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const userId = queryPositiveInteger(params, 'user_id', errors)
  const projectId = queryPositiveInteger(params, 'project_id', errors)
  const from = queryDate(params, 'from', errors)
  const to = queryDate(params, 'to', errors)
  if (from !== undefined && to !== undefined && from > to) {
    errors.push({ field: 'to', code: 'invalid_range', message: 'to must not precede from' })
  }
  assertFields(errors)
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  }
}

const plannedSeconds = (
  body: Record<string, unknown>,
  required: boolean,
  errors: FieldError[],
): number | undefined => {
  const field = 'planned_seconds_per_week'
  if (!required && !Object.hasOwn(body, field)) return undefined
  // The bounds are the domain's (assertAllocationFields); this only insists on a whole number.
  return requiredPositiveInteger(body, field, errors)
}

const createInput = (body: Record<string, unknown>): CreateAllocationRequest => {
  const errors = unknownFieldErrors(body, createKeys)
  const userId = requiredPositiveInteger(body, 'user_id', errors)
  const projectId = requiredPositiveInteger(body, 'project_id', errors)
  const startDate = requiredDate(body, 'start_date', errors)
  const endDate = requiredDate(body, 'end_date', errors)
  const planned = plannedSeconds(body, true, errors)
  assertFields(errors)
  return {
    userId: userId!,
    projectId: projectId!,
    startDate: startDate!,
    endDate: endDate!,
    plannedSecondsPerWeek: planned!,
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

const updateInput = (body: Record<string, unknown>): UpdateAllocationRequest => {
  const errors = unknownFieldErrors(body, updateKeys)
  const startDate = optionalDate(body, 'start_date', errors)
  const endDate = optionalDate(body, 'end_date', errors)
  const planned = plannedSeconds(body, false, errors)
  if (Object.keys(body).length === 0) {
    errors.push({ field: 'body', code: 'empty', message: 'at least one field is required' })
  }
  assertFields(errors)
  return {
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
    ...(planned !== undefined ? { plannedSecondsPerWeek: planned } : {}),
  }
}

const capacityRange = (url: URL): { from: string; to: string } => {
  const params = strictSearchParams(url, capacityKeys)
  const errors: FieldError[] = []
  const from = queryDate(params, 'from', errors)
  const to = queryDate(params, 'to', errors)
  for (const [field, value] of [['from', from], ['to', to]] as const) {
    if (value === undefined && !errors.some((error) => error.field === field)) {
      errors.push({ field, code: 'required', message: `${field} is required` })
    }
  }
  assertFields(errors)
  return { from: from!, to: to! }
}

/** Allocation-specific failures; the rest are the shared resource errors. */
const translateAllocationError = (error: unknown): never => {
  if (error instanceof AllocationNotFoundError) throw notFound('allocation')
  if (error instanceof AllocationOverlapError || error instanceof AllocationConflictError) {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  return translateResourceError(error, 'allocation')
}

const selfLink = (id: number) => `/api/v1/allocations/${id}`

export const installAllocationRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: AllocationRouteOptions,
): void => {
  api.get('/allocations', async (context) => {
    requireApiScope(context, 'schedule:read')
    const principal = context.get('principal')
    try {
      const url = new URL(context.req.url)
      const envelope = await cursorPage({
        requestUrl: url,
        source: options.repository.allocations(viewerOf(principal), listFilters(url)),
        viewer: principal,
        serializer: serializeAllocation,
        cursorSigningKey: options.cursorSigningKey,
      })
      return context.json(envelope, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translateAllocationError(error)
    }
  })

  api.post('/allocations', async (context) => {
    requireApiScope(context, 'schedule:write')
    const principal = context.get('principal')
    try {
      const created = await options.repository.create(
        viewerOf(principal),
        createInput(await readObjectBody(context)),
        options.clock.now().instant,
      )
      return context.json(
        { data: serializeAllocation(created), links: { self: selfLink(created.id) } },
        201,
        { 'cache-control': 'no-store', location: selfLink(created.id) },
      )
    } catch (error) {
      return translateAllocationError(error)
    }
  })

  api.get('/allocations/:id', async (context) => {
    requireApiScope(context, 'schedule:read')
    try {
      const id = resourceId(context.req.param('id'), 'allocation')
      const allocation = await options.repository.get(viewerOf(context.get('principal')), id)
      return context.json(
        { data: serializeAllocation(allocation), links: { self: selfLink(id) } },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateAllocationError(error)
    }
  })

  api.patch('/allocations/:id', async (context) => {
    requireApiScope(context, 'schedule:write')
    try {
      const id = resourceId(context.req.param('id'), 'allocation')
      const allocation = await options.repository.update(
        viewerOf(context.get('principal')),
        id,
        updateInput(await readObjectBody(context)),
        options.clock.now().instant,
      )
      return context.json(
        { data: serializeAllocation(allocation), links: { self: selfLink(id) } },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateAllocationError(error)
    }
  })

  api.delete('/allocations/:id', async (context) => {
    requireApiScope(context, 'schedule:write')
    try {
      const id = resourceId(context.req.param('id'), 'allocation')
      const allocation = await options.repository.delete(
        viewerOf(context.get('principal')),
        id,
        options.clock.now().instant,
      )
      return context.json(
        { data: serializeAllocation(allocation), links: { self: selfLink(id) } },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateAllocationError(error)
    }
  })

  api.get('/capacity', async (context) => {
    requireApiScope(context, 'schedule:read')
    try {
      const range = capacityRange(new URL(context.req.url))
      const report = await options.repository.capacity(viewerOf(context.get('principal')), range)
      return context.json(
        { data: serializeCapacity(report), links: { self: '/api/v1/capacity' } },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateAllocationError(error)
    }
  })

  installTimeOffRoutes(api, { ...options, repository: options.repository.timeOff })
}
