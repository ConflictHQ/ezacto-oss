import type { Hono } from 'hono'
import {
  CalendarConnectionError,
  type CalendarOperatorCleanupStore,
  type CalendarOperatorCleanupConfirmation,
} from '@ezacto/core'
import { requireSessionPrincipal, requireSameOriginForUnsafeSessionRequest } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'

const text = (value: unknown, max = 256) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)
const identityKeys = [
  'id',
  'user_id',
  'provider',
  'instance_nonce',
  'generation',
  'credential_revision',
  'key_id',
  'request_id',
  'reason',
  'review_instance',
  'expected_status',
  'evidence_reference',
  'confirm_provider_removed',
]
export const parseCalendarOperatorConfirmation = (
  body: Record<string, unknown>,
): CalendarOperatorCleanupConfirmation => {
  const valid =
    Object.keys(body).length === identityKeys.length &&
    Object.keys(body).every((key) => identityKeys.includes(key)) &&
    ['id', 'instance_nonce', 'key_id', 'review_instance'].every((key) => text(body[key])) &&
    ['user_id', 'generation', 'credential_revision'].every(
      (key) => Number.isSafeInteger(body[key]) && Number(body[key]) > 0,
    ) &&
    ['google', 'microsoft'].includes(String(body.provider)) &&
    ['disconnect', 'closure', 'reauth', 'restore', 'reset'].includes(String(body.reason)) &&
    ['pending', 'manual_required'].includes(String(body.expected_status)) &&
    (body.request_id === null || text(body.request_id)) &&
    text(body.evidence_reference, 1000) &&
    String(body.evidence_reference).trim().length >= 20 &&
    body.confirm_provider_removed === true
  if (!valid)
    throw validationError([
      {
        field: 'confirmation',
        code: 'invalid',
        message: 'Provide the exact reviewed cleanup identity and a protected evidence reference.',
      },
    ])
  return body as unknown as CalendarOperatorCleanupConfirmation
}
const safe = (error: unknown): never => {
  if (error instanceof ApiError) throw error
  if (error instanceof CalendarConnectionError)
    throw new ApiError({
      status: error.code === 'forbidden' ? 403 : error.code === 'invalid' ? 400 : 409,
      code: `calendar_cleanup_${error.code}`,
      message:
        'Calendar cleanup could not be confirmed. Refresh the exact obligation before retrying.',
    })
  const wrapped = new ApiError({
    status: 503,
    code: 'calendar_cleanup_unavailable',
    message: 'Calendar cleanup is temporarily unavailable.',
  })
  wrapped.cause = error
  throw wrapped
}
export const installCalendarOperatorCleanupRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  store: CalendarOperatorCleanupStore,
) => {
  const principal = (p: ReturnType<typeof requireSessionPrincipal>) => {
    if (p.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'An administrator session is required.',
      })
    return { userId: p.userId, sessionId: Number(p.authentication.sessionId) }
  }
  api.get('/admin/calendar-cleanup', async (c) => {
    const actor = principal(requireSessionPrincipal(c)),
      url = new URL(c.req.url),
      after = url.searchParams.get('after')
    if (
      [...url.searchParams.keys()].some((key) => key !== 'after') ||
      (after !== null && (!text(after) || url.searchParams.getAll('after').length !== 1))
    )
      throw validationError([
        { field: 'after', code: 'invalid', message: 'Use the returned cleanup cursor.' },
      ])
    try {
      const result = await store.list(actor, after ?? undefined)
      if (result.data.length > 100) throw new Error('Unbounded cleanup page')
      const data = result.data.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        provider: row.provider,
        instance_nonce: row.instance_nonce,
        generation: row.generation,
        credential_revision: row.credential_revision,
        key_id: row.key_id,
        request_id: row.request_id,
        reason: row.reason,
        status: row.status,
        created_at: row.created_at,
        review_instance: row.review_instance,
        provider_cleanup_in_progress: row.provider_cleanup_in_progress,
      }))
      return c.json({ data, page: { next_cursor: result.next_cursor } }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      return safe(error)
    }
  })
  api.post('/admin/calendar-cleanup/confirm', async (c) => {
    const actor = principal(requireSessionPrincipal(c))
    requireSameOriginForUnsafeSessionRequest(c.req.raw)
    const input = parseCalendarOperatorConfirmation(await readObjectBody(c))
    try {
      const receipt = await store.confirm(actor, input)
      return c.json(
        {
          data: {
            obligation_id: receipt.obligation_id,
            kind: 'operator_attestation' as const,
            provider_verified: false as const,
            attested_at: receipt.attested_at,
            evidence_sha256: receipt.evidence_sha256,
          },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return safe(error)
    }
  })
}
