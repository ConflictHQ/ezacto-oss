import {
  OrganizationHolidayError,
  type OrganizationHoliday,
  type OrganizationHolidayRepository,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { requireApiScope } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, type FieldError } from './errors.js'
import { cursorPage } from './pagination.js'
import {
  assertFields,
  queryDate,
  readObjectBody,
  resourceId,
  strictSearchParams,
  translateResourceError,
  unknownFieldErrors,
  optionalNonnegativeInteger,
} from './resources/support.js'

const serialize = (row: OrganizationHoliday) => ({
  id: row.id,
  date: row.date,
  name: row.name,
  version: row.version,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})
const self = (id: number) => `/api/v1/organization-holidays/${id}`
const translated = (error: unknown): never => {
  if (error instanceof OrganizationHolidayError)
    throw new ApiError({
      status:
        error.code === 'holiday_not_found' ? 404 : error.code === 'holiday_forbidden' ? 403 : 409,
      code: error.code,
      message: error.message,
    })
  return translateResourceError(error, 'organization holiday')
}
export const installOrganizationHolidayRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  repository: OrganizationHolidayRepository,
  options: { cursorSigningKey: Uint8Array; clock(): string },
) => {
  const administrator = (c: Context<ApiContext<Bindings>>) => {
    requireApiScope(c, 'schedule:write')
    const p = c.get('principal')
    if (p.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can change organization holidays.',
      })
    return p.userId
  }
  const input = async (c: Context<ApiContext<Bindings>>, kind: 'create' | 'update' | 'delete') => {
    const body = await readObjectBody(c, { maxBytes: 4096 })
    const allowed = new Set(
      kind === 'delete'
        ? ['version']
        : kind === 'create'
          ? ['date', 'name']
          : ['date', 'name', 'version'],
    )
    const errors: FieldError[] = unknownFieldErrors(body, allowed)
    if (kind !== 'delete') {
      if (typeof body.date !== 'string')
        errors.push({ field: 'date', code: 'required', message: 'A YYYY-MM-DD date is required.' })
      if (typeof body.name !== 'string')
        errors.push({ field: 'name', code: 'required', message: 'A holiday name is required.' })
    }
    const version =
      kind === 'create' ? undefined : optionalNonnegativeInteger(body, 'version', errors)
    if (kind !== 'create' && version === undefined && !Object.hasOwn(body, 'version'))
      errors.push({
        field: 'version',
        code: 'required',
        message: 'Use the current holiday version.',
      })
    assertFields(errors)
    return {
      date: body.date as string,
      name: typeof body.name === 'string' ? body.name.trim() : '',
      version: version!,
    }
  }
  api.get('/organization-holidays', async (c) => {
    requireApiScope(c, 'schedule:read')
    try {
      const url = new URL(c.req.url),
        params = strictSearchParams(url, new Set(['from', 'to', 'per_page', 'cursor']))
      const errors: FieldError[] = [],
        from = queryDate(params, 'from', errors),
        to = queryDate(params, 'to', errors)
      if (from && to && from > to)
        errors.push({ field: 'to', code: 'invalid_range', message: 'to must not precede from.' })
      assertFields(errors)
      return c.json(
        await cursorPage({
          requestUrl: url,
          source: repository.entries({ ...(from ? { from } : {}), ...(to ? { to } : {}) }),
          viewer: c.get('principal'),
          serializer: serialize,
          cursorSigningKey: options.cursorSigningKey,
        }),
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translated(error)
    }
  })
  api.get('/organization-holidays/:id', async (c) => {
    requireApiScope(c, 'schedule:read')
    try {
      const id = resourceId(c.req.param('id'), 'organization holiday'),
        row = await repository.get(id)
      if (!row) throw new OrganizationHolidayError('holiday_not_found')
      return c.json({ data: serialize(row), links: { self: self(id) } }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return translated(error)
    }
  })
  api.post('/organization-holidays', async (c) => {
    const actor = administrator(c)
    try {
      const value = await input(c, 'create'),
        row = await repository.create(
          actor,
          { date: value.date, name: value.name },
          options.clock(),
        )
      return c.json({ data: serialize(row), links: { self: self(row.id) } }, 201, {
        'cache-control': 'no-store',
        location: self(row.id),
      })
    } catch (error) {
      return translated(error)
    }
  })
  api.patch('/organization-holidays/:id', async (c) => {
    const actor = administrator(c)
    try {
      const id = resourceId(c.req.param('id'), 'organization holiday'),
        value = await input(c, 'update')
      const row = await repository.update(
        actor,
        id,
        { date: value.date, name: value.name },
        value.version,
        options.clock(),
      )
      return c.json({ data: serialize(row), links: { self: self(id) } }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return translated(error)
    }
  })
  api.delete('/organization-holidays/:id', async (c) => {
    const actor = administrator(c)
    try {
      const id = resourceId(c.req.param('id'), 'organization holiday'),
        value = await input(c, 'delete')
      const row = await repository.remove(actor, id, value.version, options.clock())
      return c.json({ data: serialize(row), links: { self: self(id) } }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return translated(error)
    }
  })
}
