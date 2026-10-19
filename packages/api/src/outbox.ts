import type { Hono } from 'hono'
import { ACTIVITY_EXPORT_ROW_LIMIT, renderActivityCsv } from './activity-export.js'
import { requireApiScope, requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, readJsonBody, validationError } from './errors.js'
import {
  dayRange,
  logOrder,
  logOrderFor,
  singleChoice,
  singleQuery,
  withTotal,
} from './log-paging.js'
import { keysetCursorPage } from './pagination.js'
import { isCanonicalDate } from './resources/support.js'

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
  /**
   * The `activity_log` module switch. Switching it off hides the surface and
   * refuses the read; capture is not gated here, so the evidence keeps being
   * recorded while nobody is looking at it.
   */
  isActivityLogModuleEnabled(): Promise<boolean>
  /**
   * The operator roll (issue 8). Absent where the deployment cannot roll, and
   * the routes are then not mounted rather than mounted to refuse.
   */
  roll?: ActivityRollPort
}

/** A year the hot table still holds rows for, and how many. */
export interface RollableActivityYear {
  year: number
  entries: number
}

export type ActivityRollOutcome = 'rolled' | 'current_year' | 'partition_exists'

export interface ActivityRollPort {
  /** Finished years the hot table still holds. The port owns the clock. */
  rollable(): Promise<RollableActivityYear[]>
  /**
   * Rolls `year` into its own table and records the roll as an activity event,
   * atomically. `requestId` makes a retried request record it once.
   */
  roll(input: {
    year: number
    actorUserId: number
    requestId: string
  }): Promise<ActivityRollOutcome>
}

export interface ActivityLogQuery {
  limit?: number
  from?: string
  to?: string
  eventType?: string
  actorId?: number
  excludeEventTypes?: readonly string[]
  aggregateType?: string
  aggregateId?: number
  after?: { recordedAt: string; eventId: string } | null
  recordedThrough?: string
}

export interface OutboxMonitor {
  listActivity(input?: ActivityLogQuery): Promise<ActivityLogResource[]>
  /** The latest instant an activity entry was recorded, or null when the log is empty. */
  activitySnapshot(): Promise<string | null>
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

/**
 * Identity and credential events: who signed in, which API tokens were granted
 * or revoked, who asked for their account to be deleted. Closed on purpose, to
 * match the kinds the activity log can record; a new identity kind has to be
 * named here before a non-administrator stops seeing it.
 */
const ADMINISTRATOR_ONLY_ACTIVITY_EVENTS: readonly string[] = [
  'auth.signed_in',
  'auth.signed_out',
  'api_token.created',
  'api_token.revoked',
  'two_factor.email_enabled',
  'two_factor.email_disabled',
  'account.deletion_requested',
  'timesheet_auto_approval.updated',
  'activity_log.rolled',
]

const identifierQuery = (requestUrl: URL, name: string): string | undefined => {
  const value = singleQuery(requestUrl, name)
  if (value !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw validationError([
      { field: name, code: 'invalid', message: `${name} must use 1-128 safe identifier characters` },
    ])
  }
  return value
}

const rowIdQuery = (requestUrl: URL, name: string): number | undefined => {
  const value = singleQuery(requestUrl, name)
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]{0,14}$/.test(value)) {
    throw validationError([
      { field: name, code: 'invalid', message: `${name} must be a positive integer` },
    ])
  }
  return Number(value)
}

const calendarDateQuery = (requestUrl: URL, name: string): string | undefined => {
  const value = singleQuery(requestUrl, name)
  if (value !== undefined && !isCanonicalDate(value)) {
    throw validationError([
      { field: name, code: 'invalid', message: `${name} must be a calendar date (YYYY-MM-DD)` },
    ])
  }
  return value
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

const requireActivityLogModule = async (options: OutboxRouteOptions): Promise<void> => {
  if (await options.isActivityLogModuleEnabled()) return
  throw new ApiError({
    status: 403,
    code: 'module_disabled',
    message: 'The activity log module is not enabled for this organization.',
  })
}

/**
 * The filters the activity list and its export share, so a file holds the rows
 * the screen shows (issue 8). `administrator` decides whether the sign-in,
 * token and account-deletion events are left out.
 */
const activityFilter = (requestUrl: URL, administrator: boolean): ActivityLogQuery => {
  // Each filter is validated here and refused with a 422 when it is not one:
  // a bad value that quietly matched nothing would read as "nothing happened".
  const from = calendarDateQuery(requestUrl, 'from')
  const to = calendarDateQuery(requestUrl, 'to')
  if (from !== undefined && to !== undefined && from > to) {
    throw validationError([{ field: 'to', code: 'invalid', message: 'to must not be before from' }])
  }
  const eventType = identifierQuery(requestUrl, 'event_type')
  const aggregateType = identifierQuery(requestUrl, 'aggregate_type')
  const actorId = rowIdQuery(requestUrl, 'actor_id')
  const aggregateId = rowIdQuery(requestUrl, 'aggregate_id')
  if (aggregateId !== undefined && aggregateType === undefined) {
    throw validationError([
      {
        field: 'aggregate_type',
        code: 'required',
        message: 'aggregate_type is required with aggregate_id',
      },
    ])
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(eventType === undefined ? {} : { eventType }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(aggregateType === undefined ? {} : { aggregateType }),
    ...(aggregateId === undefined ? {} : { aggregateId }),
    ...(administrator ? {} : { excludeEventTypes: ADMINISTRATOR_ONLY_ACTIVITY_EVENTS }),
  }
}

export const installOutboxRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  monitor: OutboxMonitor,
  options: OutboxRouteOptions,
): void => {
  // Not module-gated: the browser asks it to decide whether to offer the
  // surface at all, the same way /team/status does for Team.
  api.get('/activity-log/status', async (context) => {
    requireApiScope(context, 'reports:read')
    return context.json(
      {
        data: { enabled: await options.isActivityLogModuleEnabled() },
        links: { self: '/api/v1/activity-log/status' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/activity-log', async (context) => {
    requireApiScope(context, 'reports:read')
    await requireActivityLogModule(options)
    // The report audience reads the log, but the raw payloads of sign-ins,
    // token grants and account-deletion requests are an administrator's to see
    // (issue 740). Keyed on the profile, so a bearer token cannot widen it.
    const principal = context.get('principal')
    const administrator = principal.profile === 'administrator'
    const requestUrl = new URL(context.req.url)
    const filter = activityFilter(requestUrl, administrator)
    type Row = { id: number; created_at: string; record: ActivityLogResource }
    const page = await keysetCursorPage({
      requestUrl,
      cursorSigningKey: options.cursorSigningKey,
      viewer: principal,
      serializer: (row: Readonly<Row>) => activityData(row.record),
      // Newest first, on when the entry was recorded and then its event id: the
      // order the log is read in, and a total one, so a page boundary never
      // splits or repeats an entry. The id satisfies the chassis check only.
      order: logOrderFor<Row>('newest', ['string'], (row) => [
        row.record.recordedAt,
        row.record.id,
      ]),
      source: {
        snapshot: () => monitor.activitySnapshot(),
        list: async (window) =>
          (
            await monitor.listActivity({
              ...filter,
              limit: window.take,
              after:
                window.after === null
                  ? null
                  : { recordedAt: window.after[0], eventId: window.after[1] as string },
              recordedThrough: window.createdThrough,
            })
          ).map((record) => ({ id: 1, created_at: record.recordedAt, record })),
      },
    })
    return context.json(page, 200, { 'cache-control': 'no-store' })
  })

  // The filtered view as a file (issue 8). The same module gate, scope,
  // filters and administrator-only exclusions as the list above, so a file
  // never holds a row the screen would have refused the reader.
  api.get('/activity-log/export', async (context) => {
    requireApiScope(context, 'reports:read')
    await requireActivityLogModule(options)
    const principal = context.get('principal')
    const requestUrl = new URL(context.req.url)
    const filter = activityFilter(requestUrl, principal.profile === 'administrator')
    // Walked to the cap, one past it, so a log that is exactly at the cap is
    // not reported as cut. Held still at the snapshot so a row recorded while
    // the walk runs cannot shift a page boundary.
    const through = await monitor.activitySnapshot()
    const records: ActivityLogResource[] = []
    let after: { recordedAt: string; eventId: string } | null = null
    while (through !== null && records.length <= ACTIVITY_EXPORT_ROW_LIMIT) {
      const page: ActivityLogResource[] = await monitor.listActivity({
        ...filter,
        limit: 200,
        after,
        recordedThrough: through,
      })
      records.push(...page)
      const last = page[page.length - 1]
      if (page.length < 200 || last === undefined) break
      after = { recordedAt: last.recordedAt, eventId: last.id }
    }
    const truncated = records.length > ACTIVITY_EXPORT_ROW_LIMIT
    const named = [
      ...(filter.from === undefined ? [] : [`from-${filter.from}`]),
      ...(filter.to === undefined ? [] : [`to-${filter.to}`]),
    ]
    return new Response(renderActivityCsv(records.slice(0, ACTIVITY_EXPORT_ROW_LIMIT), truncated), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${['activity-log', ...named].join('-')}.csv"`,
        'x-export-truncated': String(truncated),
        'x-export-row-limit': String(ACTIVITY_EXPORT_ROW_LIMIT),
      },
    })
  })

  // The operator roll (issue 8). Session-only and administrator-only, and no
  // scope opens it: a bearer token never reaches a route that moves history
  // between tables. Module-gated like the surface that prompts for it.
  const roll = options.roll
  if (roll !== undefined) {
    api.get('/activity-log/rolls', async (context) => {
      requireAdministratorSession(context)
      await requireActivityLogModule(options)
      return context.json(
        {
          data: { rollable: await roll.rollable() },
          links: { self: '/api/v1/activity-log/rolls' },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    })

    api.post('/activity-log/rolls', async (context) => {
      const principal = requireAdministratorSession(context)
      await requireActivityLogModule(options)
      const body = await readJsonBody<unknown>(context)
      const year = typeof body === 'object' && body !== null ? (body as { year?: unknown }).year : undefined
      if (typeof year !== 'number' || !Number.isInteger(year) || year < 2000 || year > 9999) {
        throw validationError([
          { field: 'year', code: 'invalid', message: 'year must be a four-digit year' },
        ])
      }
      const outcome = await roll.roll({
        year,
        actorUserId: principal.userId,
        requestId: context.get('requestId'),
      })
      if (outcome === 'current_year') {
        throw new ApiError({
          status: 409,
          code: 'activity_year_not_finished',
          message: 'Only a finished year can be rolled; the current year is still being written.',
        })
      }
      if (outcome === 'partition_exists') {
        throw new ApiError({
          status: 409,
          code: 'activity_year_already_rolled',
          message: 'That year has already been rolled.',
        })
      }
      return context.json(
        { data: { year, rolled: true }, links: { self: '/api/v1/activity-log/rolls' } },
        201,
        { 'cache-control': 'no-store' },
      )
    })
  }

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
