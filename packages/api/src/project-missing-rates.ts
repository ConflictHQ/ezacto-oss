import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, readJsonBody, validationError } from './errors.js'
import type { GeneralResourceRouteOptions } from './general-resources.js'

export const installProjectMissingRatesRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: GeneralResourceRouteOptions['missingRates'],
  clock: () => string = () => new Date().toISOString(),
): void => {
  api.post('/projects/:id/missing-rates', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'only administrators may repair captured rates',
      })
    const rawId = context.req.param('id')
    const id = Number(rawId)
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id))
      throw new ApiError({ status: 404, code: 'not_found', message: 'project not found' })
    if (service === undefined)
      throw new ApiError({
        status: 403,
        code: 'feature_unavailable',
        message: 'missing-rate repair is unavailable in this deployment',
      })
    const body = await readJsonBody<Record<string, unknown>>(context)
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'fingerprint') ||
      (body.fingerprint !== undefined &&
        (typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)))
    ) {
      throw validationError([
        {
          field: 'fingerprint',
          code: 'invalid',
          message: 'send an empty object to preview, or the preview fingerprint to confirm',
        },
      ])
    }
    try {
      const data = await service.recover({
        projectId: id,
        actorUserId: principal.userId,
        ...(typeof body.fingerprint === 'string' ? { fingerprint: body.fingerprint } : {}),
        occurredAt: clock(),
      })
      return context.json({ data })
    } catch (error) {
      if (error instanceof RangeError)
        throw validationError([
          { field: 'project', code: 'missing_project_rate', message: error.message },
        ])
      if (error instanceof Error && error.message === 'missing_rate_preview_stale')
        throw new ApiError({
          status: 409,
          code: 'preview_stale',
          message: 'the project rate or eligible time changed; preview again before confirming',
        })
      throw error
    }
  })
}
