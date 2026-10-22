import { readObjectBody, unknownFieldErrors, assertFields } from './resources/support.js'
import type { AttachmentObjectPort } from './attachments.js'
import type { ScheduledRunOutcome, ScheduledRunsService } from '@ezacto/core'
import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export const installScheduledRunRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: ScheduledRunsService,
  objects?: AttachmentObjectPort,
): void => {
  api.use('/scheduled-runs/*', async (c, next) => {
    if (requireSessionPrincipal(c).profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can answer a proposed run.',
      })
    await next()
  })
  const runId = (value: string): number => {
    const id = Number(value)
    if (!Number.isSafeInteger(id) || id < 1)
      throw validationError([{ field: 'id', code: 'invalid', message: 'Provide a valid run id.' }])
    return id
  }
  const respond = (result: ScheduledRunOutcome) => {
    if (result.outcome === 'ok') return result.run
    if (result.outcome === 'not_found')
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'That run does not exist.',
      })
    throw new ApiError({
      status: 409,
      code: result.outcome,
      message:
        result.outcome === 'report_warnings_unacknowledged'
          ? 'Review and acknowledge the saved report warnings before confirming.'
          : result.outcome === 'expired'
            ? 'That run lapsed before anyone confirmed it, and cannot be confirmed now.'
            : 'That run is no longer waiting for an answer.',
    })
  }
  api.get('/scheduled-runs/:id', async (c) => {
    const run = await service.read(runId(c.req.param('id')))
    if (run === null)
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'That run does not exist.',
      })
    return c.json({ data: run }, 200, { 'cache-control': 'no-store' })
  })
  api.post('/scheduled-runs/:id/review-link', async (c) => {
    const id = runId(c.req.param('id')),
      actor = requireSessionPrincipal(c)
    const body = await readObjectBody(c)
    assertFields(unknownFieldErrors(body, new Set(['token'])))
    if (
      typeof body.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(body.token)
    )
      throw validationError([
        { field: 'token', code: 'invalid', message: 'Provide a valid email review link.' },
      ])
    if (!service.consumeReviewLink)
      throw new ApiError({
        status: 503,
        code: 'review_link_unavailable',
        message: 'Email review links are unavailable.',
      })
    const result = await service.consumeReviewLink(
      id,
      actor.userId,
      body.token,
      new Date().toISOString(),
    )
    if (result !== 'accepted')
      throw new ApiError({
        status: result === 'invalid' ? 404 : 409,
        code: `review_link_${result}`,
        message:
          result === 'expired'
            ? 'This email review link has expired.'
            : result === 'used'
              ? 'This email review link has already been opened.'
              : 'This email review link could not be verified.',
      })
    return c.json({ data: { path: `/scheduled-runs/${id}` } }, 200, { 'cache-control': 'no-store' })
  })
  api.get('/scheduled-runs/:id/items/:itemId/report', async (c) => {
    const report = await service.readReport?.(
      runId(c.req.param('id')),
      runId(c.req.param('itemId')),
    )
    const object = report && objects ? await objects.get(report.key) : null
    if (!report || !object)
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The saved report is unavailable.',
      })
    return new Response(object.body, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${report.name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  })
  api.post('/scheduled-runs/:id/retry', async (c) => {
    if (!service.retry)
      throw new ApiError({
        status: 409,
        code: 'not_proposed',
        message: 'Retry is unavailable for this run.',
      })
    return c.json(
      {
        data: respond(
          await service.retry(
            runId(c.req.param('id')),
            requireSessionPrincipal(c).userId,
            new Date().toISOString(),
          ),
        ),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
  api.post('/scheduled-runs/:id/confirm', async (c) => {
    const body = await readObjectBody(c, { allowEmptyObject: true, maxBytes: 4096 })
    assertFields(unknownFieldErrors(body, new Set(['acknowledge_report_warnings'])))
    if (
      body.acknowledge_report_warnings !== undefined &&
      typeof body.acknowledge_report_warnings !== 'boolean'
    )
      throw validationError([
        {
          field: 'acknowledge_report_warnings',
          code: 'invalid',
          message: 'Choose whether you reviewed the report warnings.',
        },
      ])
    return c.json(
      {
        data: respond(
          await service.confirm(
            runId(c.req.param('id')),
            requireSessionPrincipal(c).userId,
            new Date().toISOString(),
            body.acknowledge_report_warnings === true,
          ),
        ),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
  api.post('/scheduled-runs/:id/cancel', async (c) =>
    c.json(
      {
        data: respond(
          await service.cancel(
            runId(c.req.param('id')),
            requireSessionPrincipal(c).userId,
            new Date().toISOString(),
          ),
        ),
      },
      200,
      { 'cache-control': 'no-store' },
    ),
  )
}
