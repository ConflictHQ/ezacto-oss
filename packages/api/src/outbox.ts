import type { Hono } from 'hono'
import { requireApiScope, requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export type OutboxDeliveryStatus = 'pending' | 'processing' | 'delivered' | 'failed'

export interface ActivityLogResource {
  id: string
  aggregateType: string
  aggregateId: number
  aggregateSequence: number
  eventType: string
  payload: Readonly<Record<string, unknown>>
  occurredAt: string
  availableAt: string
  recordedAt: string
}

export interface OutboxDeliveryResource {
  subscriberId: string
  eventId: string
  status: OutboxDeliveryStatus
  attemptCount: number
  nextAttemptAt: string | null
  lastErrorCode: 'subscriber_timeout' | 'subscriber_rejected' | null
  deliveredAt: string | null
  failedAt: string | null
  createdAt: string
  updatedAt: string
  eventType: string
  aggregateType: string
  aggregateId: number
  aggregateSequence: number
  occurredAt: string
}

export interface OutboxMonitor {
  listActivity(input?: { limit?: number }): Promise<ActivityLogResource[]>
  listDeliveries(input?: {
    status?: OutboxDeliveryStatus
    limit?: number
  }): Promise<OutboxDeliveryResource[]>
  retryFailed(
    subscriberId: string,
    eventId: string,
  ): Promise<OutboxDeliveryResource | null>
}

const statuses = new Set<OutboxDeliveryStatus>([
  'pending',
  'processing',
  'delivered',
  'failed',
])

const pageLimit = (presented: string | undefined): number => {
  const limit = presented === undefined ? 100 : Number(presented)
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (presented !== undefined && !/^[1-9][0-9]*$/.test(presented))
  ) {
    throw validationError([
      {
        field: 'per_page',
        code: 'invalid',
        message: 'per_page must be an integer between 1 and 200',
      },
    ])
  }
  return limit
}

const requireAdministratorSession = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can inspect or retry outbox deliveries.',
    })
  }
}

const activityData = (record: ActivityLogResource) => ({
  event_id: record.id,
  event_type: record.eventType,
  aggregate: {
    type: record.aggregateType,
    id: record.aggregateId,
    sequence: record.aggregateSequence,
  },
  payload: record.payload,
  occurred_at: record.occurredAt,
  available_at: record.availableAt,
  recorded_at: record.recordedAt,
})

const deliveryData = (record: OutboxDeliveryResource) => ({
  subscriber_id: record.subscriberId,
  event_id: record.eventId,
  event_type: record.eventType,
  aggregate: {
    type: record.aggregateType,
    id: record.aggregateId,
    sequence: record.aggregateSequence,
  },
  status: record.status,
  attempt_count: record.attemptCount,
  next_attempt_at: record.nextAttemptAt,
  last_error_code: record.lastErrorCode,
  delivered_at: record.deliveredAt,
  failed_at: record.failedAt,
  occurred_at: record.occurredAt,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

export const installOutboxRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  monitor: OutboxMonitor,
): void => {
  api.get('/activity-log', async (context) => {
    requireApiScope(context, 'reports:read')
    const limit = pageLimit(context.req.query('per_page'))
    // Passed straight through. The repository validates each one and throws a
    // RangeError the error middleware turns into a 422, so a bad date is a bad
    // request here rather than an empty page that reads as "nothing happened".
    const from = context.req.query('from')
    const to = context.req.query('to')
    const eventType = context.req.query('event_type')
    const actor = context.req.query('actor_id')
    return context.json(
      {
        data: (
          await monitor.listActivity({
            limit,
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(eventType === undefined ? {} : { eventType }),
            ...(actor === undefined ? {} : { actorId: Number(actor) }),
          })
        ).map(activityData),
        links: { self: '/api/v1/activity-log' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/outbox-deliveries', async (context) => {
    requireAdministratorSession(context)
    const presentedStatus = context.req.query('status')
    if (
      presentedStatus !== undefined &&
      !statuses.has(presentedStatus as OutboxDeliveryStatus)
    ) {
      throw validationError([
        {
          field: 'status',
          code: 'unsupported',
          message: 'status is not a supported outbox delivery status',
        },
      ])
    }
    const limit = pageLimit(context.req.query('per_page'))
    const status = presentedStatus as OutboxDeliveryStatus | undefined
    return context.json(
      {
        data: (
          await monitor.listDeliveries({
            ...(status === undefined ? {} : { status }),
            limit,
          })
        ).map(deliveryData),
        links: { self: '/api/v1/outbox-deliveries' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post(
    '/outbox-deliveries/:subscriberId/:eventId/retry',
    async (context) => {
      requireAdministratorSession(context)
      const subscriberId = context.req.param('subscriberId')
      const eventId = context.req.param('eventId')
      if (
        !/^[A-Za-z0-9._:-]{1,128}$/.test(subscriberId) ||
        eventId.length < 1 ||
        eventId.length > 512
      ) {
        throw new ApiError({
          status: 404,
          code: 'not_found',
          message: 'The requested outbox delivery does not exist.',
        })
      }
      const retried = await monitor.retryFailed(subscriberId, eventId)
      if (retried === null) {
        throw new ApiError({
          status: 409,
          code: 'delivery_not_failed',
          message: 'Only a currently failed outbox delivery can be retried.',
        })
      }
      return context.json(
        {
          data: deliveryData(retried),
          links: { self: '/api/v1/outbox-deliveries' },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    },
  )
}
