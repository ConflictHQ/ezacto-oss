import type { Hono } from 'hono'
import {
  EmailSuppressionError,
  type EmailSuppressionStore,
  type EmailSuppressionRecord,
  type EmailSuppressionLift,
} from '@ezacto/mailer'
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
const serialize = (row: Readonly<EmailSuppressionRecord>) => ({
  id: row.id,
  address: row.address,
  reason: row.reason,
  first_seen_at: row.firstSeenAt,
  last_seen_at: row.lastSeenAt,
  event_count: row.events,
})
const serializeLift = (row: Readonly<EmailSuppressionLift>) => ({
  id: row.id,
  address: row.address,
  through_event_id: row.throughEventId,
  actor_user_id: row.actorId,
  note: row.note,
  complaint_acknowledged: row.complaintAcknowledged,
  lifted_at: row.liftedAt,
})
const administrator = <B extends object>(
  context: Parameters<typeof requireSessionPrincipal<B>>[0],
) => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator')
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can review suppressed email recipients.',
    })
  return principal
}
export const installEmailSuppressionRoutes = <B extends object>(
  api: Hono<ApiContext<B>>,
  store: EmailSuppressionStore,
  options: { cursorSigningKey: Uint8Array; now?: () => string },
): void => {
  api.get('/email-suppressions', async (context) => {
    const principal = administrator(context)
    const requestUrl = new URL(context.req.url)
    strictSearchParams(requestUrl, new Set(['cursor', 'per_page']))
    const page = await cursorPage({
      requestUrl,
      viewer: principal,
      cursorSigningKey: options.cursorSigningKey,
      serializer: serialize,
      source: {
        highWatermark: async () => (await store.snapshot()) || null,
        list: (window) =>
          store.list({
            snapshot: window.throughId,
            ...(window.afterId === null ? {} : { after: window.afterId }),
            take: window.take,
          }),
      },
    })
    return context.json(page, 200, { 'cache-control': 'no-store' })
  })
  api.post('/email-suppressions/:id/lift', async (context) => {
    const principal = administrator(context)
    const raw = context.req.param('id')
    const id = Number(raw)
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id))
      throw validationError([
        { field: 'id', code: 'invalid', message: 'Choose a current suppression record.' },
      ])
    const body = await readObjectBody(context)
    const fields = unknownFieldErrors(body, new Set(['note', 'confirmation']))
    if (typeof body.note !== 'string' || !body.note.trim() || body.note.trim().length > 1000)
      fields.push({
        field: 'note',
        code: 'invalid',
        message: 'Explain why delivery may be allowed again (1–1000 characters).',
      })
    if (
      body.confirmation !== undefined &&
      (typeof body.confirmation !== 'string' || body.confirmation.length > 254)
    )
      fields.push({
        field: 'confirmation',
        code: 'invalid',
        message: 'Provide the suppressed email address.',
      })
    assertFields(fields)
    try {
      const lifted = await store.lift(
        {
          eventId: id,
          actorId: principal.userId,
          note: body.note as string,
          confirmation: (body.confirmation as string | undefined) ?? '',
        },
        options.now?.() ?? new Date().toISOString(),
      )
      return context.json({ data: serializeLift(lifted) }, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      if (!(error instanceof EmailSuppressionError)) throw error
      if (error.code === 'confirmation_required' || error.code === 'invalid')
        throw validationError([
          {
            field: error.code === 'confirmation_required' ? 'confirmation' : 'note',
            code: error.code,
            message: error.message,
          },
        ])
      throw new ApiError({
        status: error.code === 'profile_forbidden' ? 403 : error.code === 'not_found' ? 404 : 409,
        code: error.code,
        message: error.message,
      })
    }
  })
}
