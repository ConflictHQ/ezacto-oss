import {
  parseExpectedRevision,
  PlaceholderAssignmentError,
  type AssignmentResult,
  type PlaceholderAllocation,
  type PlaceholderAllocationState,
  type TeamViewer,
} from '@ezacto/core'
import type { Hono } from 'hono'
import type { ApiContext } from '../context.js'
import { requireApiScope } from '../auth.js'
import { ApiError, type FieldError } from '../errors.js'
import { cursorPage, type CursorSource } from '../pagination.js'
import {
  assertFields,
  optionalDate,
  queryBoolean,
  queryDate,
  queryEnum,
  queryPositiveInteger,
  readObjectBody,
  requiredPositiveInteger,
  resourceId,
  strictSearchParams,
  translateResourceError,
  unknownFieldErrors,
} from './support.js'

export interface PlanningPlaceholderRecord {
  readonly id: number
  readonly name: string
  readonly isActive: boolean
  readonly revision: number
}
export interface PlaceholderPlanRecord extends PlaceholderAllocation {
  readonly name: string
  readonly projectName: string
}
export interface PlaceholderPlanFilters {
  projectId?: number
  state?: PlaceholderAllocationState
  from?: string
  to?: string
  afterId?: number
  throughId?: number
  limit?: number
  descending?: boolean
}
export interface PlanningPlaceholderFilters {
  isActive?: boolean
  afterId?: number
  throughId?: number
  limit?: number
  descending?: boolean
}
export interface PlaceholderPlanningRepository {
  definitions(
    viewer: Readonly<TeamViewer>,
    filters?: Readonly<PlanningPlaceholderFilters>,
  ): Promise<PlanningPlaceholderRecord[]>
  createPlaceholder(
    viewer: Readonly<TeamViewer>,
    input: Readonly<{ name: string }>,
    now: string,
  ): Promise<PlanningPlaceholderRecord>
  updatePlaceholder(
    viewer: Readonly<TeamViewer>,
    id: number,
    version: number,
    input: Readonly<{ name?: string; isActive?: false }>,
    now: string,
  ): Promise<PlanningPlaceholderRecord>
  list(
    viewer: Readonly<TeamViewer>,
    filters?: Readonly<PlaceholderPlanFilters>,
  ): Promise<PlaceholderPlanRecord[]>
  createAllocation(
    viewer: Readonly<TeamViewer>,
    input: Readonly<{
      placeholderId: number
      projectId: number
      startDate: string
      endDate: string
      plannedSecondsPerWeek: number
    }>,
    now: string,
  ): Promise<PlaceholderPlanRecord>
  updateAllocation(
    viewer: Readonly<TeamViewer>,
    id: number,
    version: number,
    input: Readonly<{
      startDate?: string
      endDate?: string
      plannedSecondsPerWeek?: number
    }>,
    now: string,
  ): Promise<PlaceholderPlanRecord>
  archive(
    viewer: Readonly<TeamViewer>,
    id: number,
    version: number,
    now: string,
  ): Promise<PlaceholderPlanRecord>
  assign(
    viewer: Readonly<TeamViewer>,
    input: Readonly<{
      idempotencyKey: string
      placeholderAllocationId: number
      expectedRevision: number
      userId: number
    }>,
    now: string,
  ): Promise<AssignmentResult>
}
export const serializePlanningPlaceholder = (
  row: PlanningPlaceholderRecord,
) => ({
  id: row.id,
  name: row.name,
  is_active: row.isActive,
  version: row.revision,
})
export const serializePlaceholderPlan = (row: PlaceholderPlanRecord) => ({
  id: Number(row.id),
  placeholder_id: Number(row.placeholderId),
  name: row.name,
  project_id: Number(row.projectId),
  project_name: row.projectName,
  start_date: row.startDate,
  end_date: row.endDate,
  planned_seconds_per_week: row.plannedSecondsPerWeek,
  state: row.state,
  version: row.revision,
  assigned_allocation_id:
    row.assignedAllocationId === null ? null : Number(row.assignedAllocationId),
})
const translated = (error: unknown): never => {
  if (error instanceof PlaceholderAssignmentError) {
    const status =
      error.code === 'placeholder_not_found'
        ? 404
        : error.code === 'placeholder_forbidden'
          ? 403
          : error.code === 'assignment_target_inactive' ||
              error.code === 'idempotency_key_reused'
            ? 422
            : 409
    throw new ApiError({
      status,
      code: error.code,
      message: error.message,
      ...(status === 422
        ? {
            fields: [
              {
                field:
                  error.code === 'idempotency_key_reused'
                    ? 'idempotency_key'
                    : 'user_id',
                code: error.code,
                message: error.message,
              },
            ],
          }
        : {}),
    })
  }
  return translateResourceError(error, 'placeholder allocation')
}
const viewerOf = (principal: {
  userId: number
  profile: TeamViewer['profile']
  managerGrants: readonly string[]
}): TeamViewer => ({
  userId: principal.userId,
  profile: principal.profile,
  managerGrants: principal.managerGrants,
})
const version = (body: Record<string, unknown>): number =>
  parseExpectedRevision(body, 'required')!
const nameInput = (body: Record<string, unknown>): string => {
  const errors = unknownFieldErrors(
    body,
    new Set(['name', ...(Object.hasOwn(body, 'version') ? ['version'] : [])]),
  )
  if (
    typeof body.name !== 'string' ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 120
  )
    errors.push({
      field: 'name',
      code: 'invalid_name',
      message: 'name must be 1 to 120 characters',
    })
  assertFields(errors)
  return (body.name as string).trim()
}
const planInput = (body: Record<string, unknown>, create: boolean) => {
  const keys = new Set([
    'start_date',
    'end_date',
    'planned_seconds_per_week',
    ...(create ? ['placeholder_id', 'project_id'] : ['version']),
  ])
  const errors = unknownFieldErrors(body, keys)
  const startDate = optionalDate(body, 'start_date', errors),
    endDate = optionalDate(body, 'end_date', errors)
  if (create) {
    for (const field of ['start_date', 'end_date'])
      if (!Object.hasOwn(body, field))
        errors.push({
          field,
          code: 'required',
          message: `${field} is required`,
        })
  }
  const seconds =
    create || Object.hasOwn(body, 'planned_seconds_per_week')
      ? requiredPositiveInteger(body, 'planned_seconds_per_week', errors)
      : undefined
  const placeholderId = create
    ? requiredPositiveInteger(body, 'placeholder_id', errors)
    : undefined
  const projectId = create
    ? requiredPositiveInteger(body, 'project_id', errors)
    : undefined
  if (!create && Object.keys(body).every((key) => key === 'version'))
    errors.push({
      field: 'body',
      code: 'empty_patch',
      message: 'Send at least one planning field',
    })
  assertFields(errors)
  return {
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
    ...(seconds !== undefined ? { plannedSecondsPerWeek: seconds } : {}),
    ...(placeholderId !== undefined ? { placeholderId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  }
}
const planFilters = (url: URL): PlaceholderPlanFilters => {
  const params = strictSearchParams(
    url,
    new Set(['project_id', 'state', 'from', 'to', 'per_page', 'cursor']),
  )
  const errors: FieldError[] = []
  const projectId = queryPositiveInteger(params, 'project_id', errors),
    state = queryEnum(
      params,
      'state',
      ['open', 'assigned', 'archived'] as const,
      errors,
    ),
    from = queryDate(params, 'from', errors),
    to = queryDate(params, 'to', errors)
  if (from !== undefined && to !== undefined && from > to)
    errors.push({
      field: 'to',
      code: 'invalid_range',
      message: 'to must not precede from',
    })
  assertFields(errors)
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  }
}
/** First-party native management commands; every authority/revision fence repeats in native SQL. */
export const installPlaceholderPlanningRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  repository: PlaceholderPlanningRepository,
  options: { clock: () => string; cursorSigningKey: Uint8Array },
): void => {
  api.get('/planning-placeholders', async (c) => {
    requireApiScope(c, 'schedule:read')
    const principal = c.get('principal'),
      viewer = viewerOf(principal)
    try {
      const url = new URL(c.req.url),
        params = strictSearchParams(
          url,
          new Set(['is_active', 'per_page', 'cursor']),
        ),
        errors: FieldError[] = []
      const active = queryBoolean(params, 'is_active', errors)
      assertFields(errors)
      const filters = active === undefined ? {} : { isActive: active }
      const source: CursorSource<PlanningPlaceholderRecord> = {
        highWatermark: async () =>
          (
            await repository.definitions(viewer, {
              ...filters,
              descending: true,
              limit: 1,
            })
          )[0]?.id ?? null,
        list: (window) =>
          repository.definitions(viewer, {
            ...filters,
            ...(window.afterId === null ? {} : { afterId: window.afterId }),
            throughId: window.throughId,
            limit: window.take,
          }),
      }
      return c.json(
        await cursorPage({
          requestUrl: url,
          source,
          viewer: principal,
          serializer: serializePlanningPlaceholder,
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translated(error)
    }
  })
  api.post('/planning-placeholders', async (c) => {
    requireApiScope(c, 'schedule:write')
    try {
      const body = await readObjectBody(c)
      assertFields(unknownFieldErrors(body, new Set(['name'])))
      return c.json(
        {
          data: serializePlanningPlaceholder(
            await repository.createPlaceholder(
              viewerOf(c.get('principal')),
              { name: nameInput(body) },
              options.clock(),
            ),
          ),
        },
        201,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translated(error)
    }
  })
  for (const method of ['patch', 'delete'] as const)
    api[method]('/planning-placeholders/:id', async (c) => {
      requireApiScope(c, 'schedule:write')
      try {
        const body = await readObjectBody(c),
          expected = version(body)
        if (method === 'delete')
          assertFields(unknownFieldErrors(body, new Set(['version'])))
        const patch =
          method === 'delete'
            ? { isActive: false as const }
            : { name: nameInput(body) }
        return c.json(
          {
            data: serializePlanningPlaceholder(
              await repository.updatePlaceholder(
                viewerOf(c.get('principal')),
                resourceId(c.req.param('id'), 'planning placeholder'),
                expected,
                patch,
                options.clock(),
              ),
            ),
          },
          200,
          { 'cache-control': 'no-store' },
        )
      } catch (error) {
        return translated(error)
      }
    })
  api.get('/placeholder-allocations', async (c) => {
    requireApiScope(c, 'schedule:read')
    const principal = c.get('principal'),
      viewer = viewerOf(principal)
    try {
      const url = new URL(c.req.url),
        filters = planFilters(url)
      const source: CursorSource<
        Omit<PlaceholderPlanRecord, 'id'> & { id: number }
      > = {
        highWatermark: async () => {
          const row = (
            await repository.list(viewer, {
              ...filters,
              descending: true,
              limit: 1,
            })
          )[0]
          return row ? Number(row.id) : null
        },
        list: async (window) =>
          (
            await repository.list(viewer, {
              ...filters,
              ...(window.afterId === null ? {} : { afterId: window.afterId }),
              throughId: window.throughId,
              limit: window.take,
            })
          ).map((row) => ({ ...row, id: Number(row.id) })),
      }
      return c.json(
        await cursorPage({
          requestUrl: url,
          source,
          viewer: principal,
          serializer: (row) =>
            serializePlaceholderPlan({ ...row, id: String(row.id) }),
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translated(error)
    }
  })
  api.post('/placeholder-allocations', async (c) => {
    requireApiScope(c, 'schedule:write')
    try {
      const input = planInput(await readObjectBody(c), true)
      const created = await repository.createAllocation(
        viewerOf(c.get('principal')),
        input as Required<typeof input>,
        options.clock(),
      )
      return c.json({ data: serializePlaceholderPlan(created) }, 201, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return translated(error)
    }
  })
  for (const method of ['patch', 'delete'] as const)
    api[method]('/placeholder-allocations/:id', async (c) => {
      requireApiScope(c, 'schedule:write')
      try {
        const body = await readObjectBody(c),
          expected = version(body),
          id = resourceId(c.req.param('id'), 'placeholder allocation')
        if (method === 'delete')
          assertFields(unknownFieldErrors(body, new Set(['version'])))
        const viewer = viewerOf(c.get('principal'))
        const row =
          method === 'delete'
            ? await repository.archive(viewer, id, expected, options.clock())
            : await repository.updateAllocation(
                viewer,
                id,
                expected,
                planInput(body, false),
                options.clock(),
              )
        return c.json({ data: serializePlaceholderPlan(row) }, 200, {
          'cache-control': 'no-store',
        })
      } catch (error) {
        return translated(error)
      }
    })
  api.post('/placeholder-allocations/:id/assign', async (c) => {
    requireApiScope(c, 'schedule:write')
    try {
      const body = await readObjectBody(c),
        errors = unknownFieldErrors(
          body,
          new Set(['version', 'user_id', 'idempotency_key']),
        ),
        expected = version(body),
        userId = requiredPositiveInteger(body, 'user_id', errors)
      if (
        typeof body.idempotency_key !== 'string' ||
        body.idempotency_key.length < 1 ||
        body.idempotency_key.length > 200
      )
        errors.push({
          field: 'idempotency_key',
          code: 'invalid_key',
          message: 'idempotency_key must be 1 to 200 characters',
        })
      assertFields(errors)
      const viewer = viewerOf(c.get('principal')),
        id = resourceId(c.req.param('id'), 'placeholder allocation')
      const result = await repository.assign(
        viewer,
        {
          idempotencyKey: body.idempotency_key as string,
          placeholderAllocationId: id,
          expectedRevision: expected,
          userId: userId!,
        },
        options.clock(),
      )
      const [row] = await repository.list(viewer, {
        afterId: id - 1,
        throughId: id,
        limit: 1,
      })
      if (!row)
        throw new ApiError({
          status: 404,
          code: 'placeholder_not_found',
          message: 'The placeholder is outside your scope.',
        })
      const allocation = result.allocation
      return c.json(
        {
          data: {
            allocation: {
              id: Number(allocation.id),
              version: 0,
              user_id: Number(allocation.userId),
              project_id: Number(allocation.projectId),
              start_date: allocation.startDate,
              end_date: allocation.endDate,
              planned_seconds_per_week: allocation.plannedSecondsPerWeek,
            },
            placeholder: serializePlaceholderPlan({
              ...row,
              ...result.placeholder,
              name:
                (result.placeholder as Partial<PlaceholderPlanRecord>).name ??
                row.name,
              projectName:
                (result.placeholder as Partial<PlaceholderPlanRecord>)
                  .projectName ?? row.projectName,
            }),
            warnings: result.warnings.map((warning) => ({
              code: warning.code,
              week_start: warning.weekStart,
              planned_seconds: warning.plannedSeconds,
              capacity_seconds: warning.capacitySeconds,
            })),
            prerequisites: result.prerequisites,
          },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translated(error)
    }
  })
}
