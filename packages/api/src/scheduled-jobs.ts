import {
  ScheduledJobError,
  scheduledJobConfig,
  type ScheduledJob,
  type ScheduledJobsService,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { cursorPage } from './pagination.js'
import {
  readObjectBody,
  strictSearchParams,
  unknownFieldErrors,
  assertFields,
} from './resources/support.js'

const serialize = (job: ScheduledJob) => ({
  id: job.id,
  version: job.version,
  action: job.action,
  name: job.name,
  scope: job.scope,
  cadence: job.cadence,
  confirmation: job.confirmation,
  confirm_within_minutes: job.confirm_within_minutes,
  is_active: job.is_active,
  created_by: job.created_by,
  created_at: job.created_at,
  updated_at: job.updated_at,
  last_checked_at: job.last_checked_at,
  last_error: job.last_error,
  last_run_id: job.last_run_id,
})

export const installScheduledJobRoutes = <B extends object>(
  api: Hono<ApiContext<B>>,
  service: ScheduledJobsService,
  options: { cursorSigningKey: Uint8Array; now?: () => string },
): void => {
  const administrator = (context: Parameters<typeof requireSessionPrincipal<B>>[0]) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators may configure scheduled jobs.',
      })
    return principal
  }
  const id = (value: string) => {
    const parsed = Number(value)
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed))
      throw validationError([{ field: 'id', code: 'invalid', message: 'Choose a scheduled job.' }])
    return parsed
  }
  const translate = (error: unknown): never => {
    if (!(error instanceof ScheduledJobError)) throw error
    if (error.code === 'invalid')
      throw validationError([{ field: error.field, code: 'invalid', message: error.message }])
    throw new ApiError({
      status: error.code === 'profile_forbidden' ? 403 : error.code === 'not_found' ? 404 : 409,
      code: error.code,
      message: error.message,
    })
  }
  api.get('/scheduled-jobs', async (c) => {
    const viewer = administrator(c)
    const requestUrl = new URL(c.req.url)
    strictSearchParams(requestUrl, new Set(['cursor', 'per_page']))
    const page = await cursorPage({
      requestUrl,
      viewer,
      cursorSigningKey: options.cursorSigningKey,
      serializer: serialize,
      source: {
        highWatermark: async () => (await service.snapshot()) || null,
        list: (window) => service.list(window),
      },
    })
    return c.json(page, 200, { 'cache-control': 'no-store' })
  })
  api.get('/scheduled-jobs/:id', async (c) => {
    administrator(c)
    const job = await service.read(id(c.req.param('id')))
    if (!job)
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'That scheduled job does not exist.',
      })
    return c.json({ data: serialize(job) }, 200, { 'cache-control': 'no-store' })
  })
  api.post('/scheduled-jobs', async (c) => {
    const actor = administrator(c)
    const body = await readObjectBody(c)
    try {
      const job = await service.create(
        actor.userId,
        scheduledJobConfig(body),
        options.now?.() ?? new Date().toISOString(),
      )
      return c.json({ data: serialize(job) }, 201, { 'cache-control': 'no-store' })
    } catch (error) {
      return translate(error)
    }
  })
  api.patch('/scheduled-jobs/:id', async (c) => {
    const actor = administrator(c)
    const jobId = id(c.req.param('id'))
    const { expected_version, ...patch } = await readObjectBody(c)
    assertFields(
      unknownFieldErrors(
        patch,
        new Set([
          'action',
          'name',
          'scope',
          'cadence',
          'confirmation',
          'confirm_within_minutes',
          'is_active',
        ]),
      ),
    )
    if (!Number.isSafeInteger(expected_version) || Number(expected_version) < 0)
      throw validationError([
        {
          field: 'expected_version',
          code: 'invalid',
          message: 'Provide the reviewed job version.',
        },
      ])
    try {
      const job = await service.update(
        actor.userId,
        jobId,
        Number(expected_version),
        patch,
        options.now?.() ?? new Date().toISOString(),
      )
      return c.json({ data: serialize(job) }, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translate(error)
    }
  })
}
