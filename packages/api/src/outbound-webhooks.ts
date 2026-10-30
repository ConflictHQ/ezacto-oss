import {
  WebhookError,
  webhookEventTypes,
  webhookDeliveryStatuses,
  webhookLimits,
  type WebhookManagement,
  type WebhookSubscription,
  type WebhookDelivery,
  type WebhookDeliveryFilter,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody, unknownFieldErrors, isJsonObject } from './resources/support.js'
import { keysetCursorPage, type KeysetOrder } from './pagination.js'

const subscriptionBody = (s: WebhookSubscription) => ({
  id: s.id,
  url: s.url,
  events: s.events,
  is_active: s.isActive,
  version: s.version,
  generation: s.generation,
  previous_valid_until: s.previousValidUntil,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
  deleted_at: s.deletedAt,
})
const deliveryBody = (d: WebhookDelivery) => ({
  id: d.id,
  subscription_id: d.subscriptionId,
  event_id: d.eventId,
  event_type: d.eventType,
  payload_json: d.payloadJson,
  status: d.status,
  attempt_count: d.attemptCount,
  cycle_attempts: d.cycleAttempts,
  replay_count: d.replayCount,
  last_status: d.lastStatus,
  last_error_code: d.lastErrorCode,
  next_attempt_at: d.nextAttemptAt,
  last_attempt_at: d.lastAttemptAt,
  delivered_at: d.deliveredAt,
  failed_at: d.failedAt,
  created_at: d.createdAt,
  updated_at: d.updatedAt,
})
const invalid = (field: string, message: string): never => {
  throw validationError([{ field, code: 'invalid', message }])
}
const versionOf = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    return invalid('version', 'Use the current nonnegative subscription version.')
  return value as number
}
const subscriptionId = (value: string) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value))
    return invalid('id', 'Expected a subscription UUID.')
  return value
}
const deliveryId = (value: string) => {
  if (!/^[0-9a-f]{32}$/.test(value)) return invalid('id', 'Expected a delivery ID.')
  return value
}
type Position = { createdAt: string; id: string }
type DeliveryRow = WebhookDelivery & { created_at: string }
const order: KeysetOrder<DeliveryRow, Position> = {
  positionOf: (row) => ({ createdAt: row.createdAt, id: row.id }),
  compare: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  encode: (p) => p,
  decode: (p) =>
    isJsonObject(p) &&
    typeof p.createdAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.createdAt) &&
    typeof p.id === 'string' &&
    /^[0-9a-f]{32}$/.test(p.id)
      ? { createdAt: p.createdAt, id: p.id }
      : null,
}
export const installOutboundWebhookRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: WebhookManagement,
  options: { cursorSigningKey: Uint8Array },
) => {
  const admin = (context: Context<ApiContext<Bindings>>) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can manage webhooks.',
      })
    context.header('cache-control', 'no-store')
    return principal.userId
  }
  const body = async (context: Context<ApiContext<Bindings>>, fields: string[]) => {
    const value = await readObjectBody(context, { maxBytes: 8192 })
    const errors = unknownFieldErrors(value, new Set(fields))
    if (errors.length) throw validationError(errors)
    return value
  }
  const perform = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action()
    } catch (e) {
      if (!(e instanceof WebhookError)) throw e
      const status =
        e.code === 'webhook_forbidden'
          ? 403
          : e.code.includes('not_found')
            ? 404
            : e.code === 'webhook_secret_unavailable'
              ? 503
              : [
                    'webhook_conflict',
                    'webhook_subscription_limit',
                    'webhook_rotation_overlap_active',
                    'webhook_replay_expired',
                  ].includes(e.code)
                ? 409
                : 422
      throw new ApiError({
        status,
        code: e.code,
        message: e.message,
        ...(status === 422
          ? { fields: [{ field: e.field, code: e.code, message: e.message }] }
          : {}),
      })
    }
  }
  api.get('/webhook-subscriptions', async (c) => {
    admin(c)
    return c.json({
      data: (await service.list()).map(subscriptionBody),
      configuration: {
        ready: service.configured,
        event_types: webhookEventTypes,
        max_subscriptions: webhookLimits.subscriptions,
        rotation_overlap_seconds: webhookLimits.rotationOverlapSeconds,
      },
      links: { self: '/api/v1/webhook-subscriptions' },
    })
  })
  api.post('/webhook-subscriptions', async (c) => {
    const actor = admin(c),
      value = await body(c, ['url', 'events'])
    if (typeof value.url !== 'string') invalid('url', 'An HTTPS endpoint URL is required.')
    const result = await perform(() =>
      service.create(actor, { url: value.url as string, events: value.events }),
    )
    return c.json(
      { data: subscriptionBody(result.subscription), signing_secret: result.secret },
      201,
    )
  })
  api.patch('/webhook-subscriptions/:id', async (c) => {
    const actor = admin(c),
      id = subscriptionId(c.req.param('id')),
      value = await body(c, ['version', 'is_active'])
    if (typeof value.is_active !== 'boolean') invalid('is_active', 'Use true or false.')
    return c.json({
      data: subscriptionBody(
        await perform(() =>
          service.setActive(actor, id, value.is_active as boolean, versionOf(value.version)),
        ),
      ),
    })
  })
  api.post('/webhook-subscriptions/:id/rotate-secret', async (c) => {
    const actor = admin(c),
      id = subscriptionId(c.req.param('id')),
      value = await body(c, ['version', 'overlap_seconds'])
    if (
      value.overlap_seconds !== undefined &&
      (!Number.isSafeInteger(value.overlap_seconds) ||
        (value.overlap_seconds as number) < 0 ||
        (value.overlap_seconds as number) > webhookLimits.maxRotationOverlapSeconds)
    )
      invalid('overlap_seconds', 'Use an integer between 0 and 86400.')
    const result = await perform(() =>
      service.rotate(actor, id, {
        version: versionOf(value.version),
        ...(value.overlap_seconds === undefined
          ? {}
          : { overlapSeconds: value.overlap_seconds as number }),
      }),
    )
    return c.json({ data: subscriptionBody(result.subscription), signing_secret: result.secret })
  })
  api.delete('/webhook-subscriptions/:id', async (c) => {
    const actor = admin(c),
      id = subscriptionId(c.req.param('id')),
      value = await body(c, ['version'])
    return c.json({
      data: subscriptionBody(
        await perform(() => service.remove(actor, id, versionOf(value.version))),
      ),
    })
  })
  api.get('/webhook-deliveries', async (c) => {
    admin(c)
    const url = new URL(c.req.url),
      filter: WebhookDeliveryFilter = {}
    for (const key of url.searchParams.keys()) {
      if (!['subscription_id', 'status', 'per_page', 'cursor'].includes(key))
        invalid(key, 'Unknown filter.')
      if (url.searchParams.getAll(key).length > 1) invalid(key, 'Use each filter once.')
    }
    const sub = url.searchParams.get('subscription_id'),
      status = url.searchParams.get('status')
    if (sub !== null) filter.subscriptionId = subscriptionId(sub)
    if (status !== null) {
      if (!webhookDeliveryStatuses.includes(status as never))
        invalid('status', 'Unknown delivery status.')
      filter.status = status as WebhookDeliveryFilter['status'] & string
    }
    return c.json(
      await keysetCursorPage({
        requestUrl: url,
        source: {
          snapshot: () => service.deliveriesSnapshot(filter),
          list: async (window) =>
            (await service.pageDeliveries({ ...filter, ...window })).map((d) => ({
              ...d,
              created_at: d.createdAt,
            })),
        },
        order,
        viewer: {},
        serializer: deliveryBody,
        cursorSigningKey: options.cursorSigningKey,
      }),
    )
  })
  api.post('/webhook-deliveries/:id/replay', async (c) => {
    const actor = admin(c),
      id = deliveryId(c.req.param('id'))
    await body(c, [])
    return c.json({ data: deliveryBody(await perform(() => service.replay(actor, id))) }, 202)
  })
}
