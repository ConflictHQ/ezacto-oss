import type { Hono } from 'hono'
import { requireApiScope, requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import {
  dayRange,
  logOrder,
  logOrderFor,
  singleChoice,
  singleQuery,
  withTotal,
} from './log-paging.js'
import { keysetCursorPage } from './pagination.js'

export type OutboxDeliveryStatus = 'pending' | 'processing' | 'delivered' | 'failed'

/**
 * Who caused an event (issue 862). `type` and `id` are what the event
 * recorded; `name` is resolved by the repository when the log is read, and is
 * null for a system event and for an id no user or contact carries any more.
 */
export interface ActivityLogActor {
  type: 'user' | 'contact' | 'system'
  id: number | null
  name: string | null
}

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
  actor: ActivityLogActor | null
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

export interface OutboxDeliveryFilter {
  status?: OutboxDeliveryStatus
  eventType?: string
  createdFrom?: string
  createdBefore?: string
}

export interface OutboxDeliveryPageWindow extends OutboxDeliveryFilter {
  order: 'newest' | 'oldest'
  after: { createdAt: string; subscriberId: string; eventId: string } | null
  createdThrough: string
  take: number
}

export interface OutboxRouteOptions {
  /** Signs the page cursors. */
  cursorSigningKey: Uint8Array
  /** The organization's timezone, which decides where a calendar day begins. */
  timezone(): Promise<string>
}

export interface OutboxMonitor {
  listActivity(input?: { limit?: number }): Promise<ActivityLogResource[]>
  /** The latest delivery creation instant, or null when there are none. */
  deliveriesSnapshot(): Promise<string | null>
  pageDeliveries(window: OutboxDeliveryPageWindow): Promise<OutboxDeliveryResource[]>
  countDeliveries(filter: OutboxDeliveryFilter): Promise<number>
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
) => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can inspect or retry outbox deliveries.',
    })
  }
  return principal
}

// The actor sits beside the payload rather than inside it. The payload is the
// event as recorded; a name looked up when the log is read is not part of it.
const activityData = (record: ActivityLogResource) => ({
  event_id: record.id,
  event_type: record.eventType,
  aggregate: {
    type: record.aggregateType,
    id: record.aggregateId,
    sequence: record.aggregateSequence,
  },
  actor:
    record.actor === null
      ? null
      : { type: record.actor.type, id: record.actor.id, name: record.actor.name },
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
  options: OutboxRouteOptions,
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
    const principal = requireAdministratorSession(context)
    const requestUrl = new URL(context.req.url)
    const status = singleChoice(requestUrl, 'status', [...statuses])
    const eventType = singleQuery(requestUrl, 'event_type')
    if (eventType !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(eventType)) {
      throw validationError([
        {
          field: 'event_type',
          code: 'invalid',
          message: 'event_type must use 1-128 safe identifier characters',
        },
      ])
    }
    const days =
      requestUrl.searchParams.has('from') || requestUrl.searchParams.has('to')
        ? dayRange(requestUrl, await options.timezone())
        : {}
    const filter: OutboxDeliveryFilter = {
      ...(status === undefined ? {} : { status }),
      ...(eventType === undefined ? {} : { eventType }),
      ...days,
    }
    const order = logOrder(requestUrl)
    type Row = { id: number; created_at: string; record: OutboxDeliveryResource }
    const page = await keysetCursorPage({
      requestUrl,
      cursorSigningKey: options.cursorSigningKey,
      viewer: principal,
      serializer: (row: Readonly<Row>) => deliveryData(row.record),
      // A delivery is keyed by its subscriber and event, not by a number, and
      // the chassis asks every row for a positive id. The position below is
      // what orders and resumes the page; this id only satisfies the check.
      order: logOrderFor<Row>(order, ['string', 'string'], (row) => [
        row.created_at,
        row.record.subscriberId,
        row.record.eventId,
      ]),
      source: {
        snapshot: () => monitor.deliveriesSnapshot(),
        list: async (window) =>
          (
            await monitor.pageDeliveries({
              ...filter,
              order,
              after:
                window.after === null
                  ? null
                  : {
                      createdAt: window.after[0],
                      subscriberId: window.after[1] as string,
                      eventId: window.after[2] as string,
                    },
              createdThrough: window.createdThrough,
              take: window.take,
            })
          ).map((record) => ({ id: 1, created_at: record.createdAt, record })),
      },
    })
    return context.json(withTotal(page, await monitor.countDeliveries(filter)), 200, {
      'cache-control': 'no-store',
    })
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
