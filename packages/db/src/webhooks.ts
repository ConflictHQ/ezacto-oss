import {
  WebhookError,
  webhookUrl,
  webhookEvents,
  webhookLimits,
  webhookBody,
  webhookSignature,
  createWebhookSigningSecret,
  type WebhookSubscription,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookDeliveryError,
  type WebhookSecretVault,
  type WebhookTransport,
  type WebhookDeliveryFilter,
  type WebhookDeliveryWindow,
} from '@ezacto/core'
import {
  atomic,
  nativeClient,
  activityCaptureStatements,
  type ActivityDatabase,
  type ActivityEventType,
} from './activity-log.js'
type Client = ReturnType<typeof nativeClient>
type Statement = { sql: string; params: readonly unknown[] }
interface SubscriptionRow {
  id: string
  url: string
  events_json: string
  is_active: number
  version: number
  generation: number
  current_secret: string | null
  previous_secret: string | null
  previous_generation: number | null
  previous_valid_until: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
interface DeliveryRow {
  id: string
  subscription_id: string
  event_id: string
  event_type: WebhookDelivery['eventType']
  payload_json: string
  status: WebhookDeliveryStatus
  attempt_count: number
  cycle_attempts: number
  replay_count: number
  lease_token: string | null
  lease_expires_at: string | null
  next_attempt_at: string | null
  last_attempt_at: string | null
  last_status: number | null
  last_error_code: WebhookDeliveryError | null
  delivered_at: string | null
  failed_at: string | null
  created_at: string
  updated_at: string
}
const publicSubscription = (row: SubscriptionRow): WebhookSubscription => ({
  id: row.id,
  url: row.url,
  events: webhookEvents(JSON.parse(row.events_json)),
  isActive: row.is_active === 1,
  version: row.version,
  generation: row.generation,
  previousValidUntil: row.previous_valid_until,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
})
const publicDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  subscriptionId: row.subscription_id,
  eventId: row.event_id,
  eventType: row.event_type,
  payloadJson: row.payload_json,
  status: row.status,
  attemptCount: row.attempt_count,
  cycleAttempts: row.cycle_attempts,
  replayCount: row.replay_count,
  lastStatus: row.last_status,
  lastErrorCode: row.last_error_code,
  nextAttemptAt: row.next_attempt_at,
  lastAttemptAt: row.last_attempt_at,
  deliveredAt: row.delivered_at,
  failedAt: row.failed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
const publicColumns = `id,url,events_json,is_active,version,generation,previous_valid_until,created_at,updated_at,deleted_at`
const rows = async <T>(
  client: Client,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> => {
  if ('batch' in client)
    return (
      await client
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results
  return client.prepare(sql).all(...params) as T[]
}
const first = async <T>(client: Client, sql: string, params: readonly unknown[] = []) =>
  (await rows<T>(client, sql, params))[0] ?? null
const plus = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString()
const stateError = () => new WebhookError('webhook_conflict', 'version')
const filterSql = (filter: WebhookDeliveryFilter) => {
  const clauses: string[] = [],
    params: unknown[] = []
  if (filter.subscriptionId !== undefined) {
    clauses.push('subscription_id=?')
    params.push(filter.subscriptionId)
  }
  if (filter.status !== undefined) {
    clauses.push('status=?')
    params.push(filter.status)
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1', params }
}

export const createWebhookService = (
  database: ActivityDatabase,
  options: {
    vault: WebhookSecretVault | null
    transport: WebhookTransport
    clock?: () => string
  },
) => {
  const client = nativeClient(database),
    clock = options.clock ?? (() => new Date().toISOString())
  const execute = (statements: readonly Statement[]) => atomic(client, statements)
  const privateSubscription = (id: string) =>
    first<SubscriptionRow>(client, 'SELECT * FROM webhook_subscriptions WHERE id=?', [id])
  const get = async (id: string) => {
    const row = await first<SubscriptionRow>(
      client,
      `SELECT ${publicColumns} FROM webhook_subscriptions WHERE id=?`,
      [id],
    )
    return row ? publicSubscription(row) : null
  }
  const list = async () =>
    (
      await rows<SubscriptionRow>(
        client,
        `SELECT ${publicColumns} FROM webhook_subscriptions WHERE deleted_at IS NULL ORDER BY created_at,id`,
      )
    ).map(publicSubscription)
  const audit = (
    type: ActivityEventType,
    actor: number,
    now: string,
    detail: Readonly<Record<string, unknown>>,
  ) =>
    activityCaptureStatements({
      eventType: type,
      subjectId: 1,
      actor: { type: 'user', id: actor },
      occurredAt: now,
      captureId: crypto.randomUUID(),
      detail,
    }).statements
  const mutate = async (
    actor: number,
    condition: string,
    params: readonly unknown[],
    statements: readonly Statement[],
  ) => {
    if (!Number.isSafeInteger(actor) || actor < 1) throw new WebhookError('webhook_forbidden')
    try {
      await execute([
        {
          sql: `INSERT INTO webhook_command_guard(singleton,allowed) SELECT 1,CASE WHEN
          EXISTS(SELECT 1 FROM users WHERE id=? AND profile='administrator' AND is_active=1)
          AND (${condition}) THEN 1 ELSE 0 END WHERE 1 ON CONFLICT(singleton) DO UPDATE SET allowed=excluded.allowed`,
          params: [actor, ...params],
        },
        ...statements,
      ])
    } catch (error) {
      if (error instanceof Error && /allowed\s*=\s*1/.test(error.message)) {
        const active = await first(
          client,
          "SELECT 1 FROM users WHERE id=? AND profile='administrator' AND is_active=1",
          [actor],
        )
        if (!active) throw new WebhookError('webhook_forbidden')
        throw stateError()
      }
      if (error instanceof Error && error.message.includes('webhook_subscription_limit'))
        throw new WebhookError('webhook_subscription_limit', 'subscriptions')
      throw error
    }
  }
  const vault = () => {
    if (!options.vault) throw new WebhookError('webhook_secret_unavailable', 'configuration')
    return options.vault
  }
  const create = async (actor: number, input: { url: string; events: unknown }) => {
    const url = webhookUrl(input.url),
      events = webhookEvents(input.events),
      id = crypto.randomUUID(),
      now = clock()
    const secret = createWebhookSigningSecret(),
      sealed = await vault().seal(secret, { subscriptionId: id, generation: 1 })
    await mutate(
      actor,
      '(SELECT count(*) FROM webhook_subscriptions WHERE deleted_at IS NULL)<?',
      [webhookLimits.subscriptions],
      [
        {
          sql: `INSERT INTO webhook_subscriptions(id,url,events_json,generation,current_secret,created_by_user_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?)`,
          params: [id, url, JSON.stringify(events), sealed, actor, now, now],
        },
        ...audit('webhook_subscription.created', actor, now, {
          subscription_id: id,
          event_count: events.length,
        }),
      ],
    )
    return { subscription: (await get(id))!, secret }
  }
  const setActive = async (actor: number, id: string, isActive: boolean, version: number) => {
    if (isActive) vault()
    const now = clock()
    await mutate(
      actor,
      'EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=? AND version=? AND deleted_at IS NULL)',
      [id, version],
      [
        {
          sql: 'UPDATE webhook_subscriptions SET is_active=?,version=version+1,updated_at=? WHERE id=?',
          params: [isActive ? 1 : 0, now, id],
        },
        ...audit(
          isActive ? 'webhook_subscription.resumed' : 'webhook_subscription.paused',
          actor,
          now,
          { subscription_id: id },
        ),
      ],
    )
    return (await get(id))!
  }
  const rotate = async (
    actor: number,
    id: string,
    input: { version: number; overlapSeconds?: number },
  ) => {
    const overlap = input.overlapSeconds ?? webhookLimits.rotationOverlapSeconds,
      now = clock(),
      row = await privateSubscription(id)
    if (!row || row.deleted_at !== null) throw new WebhookError('webhook_not_found', 'id')
    if (
      !Number.isSafeInteger(overlap) ||
      overlap < 0 ||
      overlap > webhookLimits.maxRotationOverlapSeconds
    )
      throw new WebhookError('invalid_webhook_overlap', 'overlap_seconds')
    if (row.version !== input.version) throw stateError()
    if (
      overlap > 0 &&
      row.previous_valid_until !== null &&
      Date.parse(row.previous_valid_until) > Date.parse(now)
    )
      throw new WebhookError('webhook_rotation_overlap_active', 'overlap_seconds')
    const cipher = vault()
    if (overlap > 0)
      await cipher.open(row.current_secret!, { subscriptionId: id, generation: row.generation })
    const secret = createWebhookSigningSecret(),
      generation = row.generation + 1
    const sealed = await cipher.seal(secret, { subscriptionId: id, generation })
    await mutate(
      actor,
      'EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=? AND version=? AND deleted_at IS NULL)',
      [id, input.version],
      [
        {
          sql: `UPDATE webhook_subscriptions SET current_secret=?,generation=?,previous_secret=?,previous_generation=?,previous_valid_until=?,version=version+1,updated_at=? WHERE id=?`,
          params: [
            sealed,
            generation,
            overlap > 0 ? row.current_secret : null,
            overlap > 0 ? row.generation : null,
            overlap > 0 ? plus(now, overlap) : null,
            now,
            id,
          ],
        },
        ...audit('webhook_subscription.secret_rotated', actor, now, {
          subscription_id: id,
          generation,
          overlap_seconds: overlap,
        }),
      ],
    )
    return { subscription: (await get(id))!, secret }
  }
  const remove = async (actor: number, id: string, version: number) => {
    const now = clock()
    await mutate(
      actor,
      'EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=? AND version=? AND deleted_at IS NULL)',
      [id, version],
      [
        {
          sql: `UPDATE webhook_subscriptions SET is_active=0,current_secret=NULL,previous_secret=NULL,previous_generation=NULL,previous_valid_until=NULL,deleted_at=?,updated_at=?,version=version+1 WHERE id=?`,
          params: [now, now, id],
        },
        {
          sql: `UPDATE webhook_deliveries SET status='failed',last_error_code='subscription_deleted',failed_at=?,updated_at=?,next_attempt_at=NULL,lease_token=NULL,lease_expires_at=NULL WHERE subscription_id=? AND status IN ('pending','processing')`,
          params: [now, now, id],
        },
        ...audit('webhook_subscription.deleted', actor, now, { subscription_id: id }),
      ],
    )
    return (await get(id))!
  }
  const delivery = async (id: string) => {
    const row = await first<DeliveryRow>(client, 'SELECT * FROM webhook_deliveries WHERE id=?', [
      id,
    ])
    return row ? publicDelivery(row) : null
  }
  const replay = async (actor: number, id: string) => {
    vault()
    const row = await first<DeliveryRow>(client, 'SELECT * FROM webhook_deliveries WHERE id=?', [
        id,
      ]),
      now = clock()
    if (!row) throw new WebhookError('webhook_delivery_not_found', 'id')
    if (row.status !== 'failed' && row.status !== 'delivered') throw stateError()
    if (Date.parse(row.created_at) < Date.parse(now) - webhookLimits.replayWindowSeconds * 1000)
      throw new WebhookError('webhook_replay_expired', 'id')
    await mutate(
      actor,
      `EXISTS(SELECT 1 FROM webhook_deliveries delivery JOIN webhook_subscriptions subscription ON subscription.id=delivery.subscription_id
      WHERE delivery.id=? AND delivery.status IN ('failed','delivered') AND delivery.replay_count=?
        AND subscription.is_active=1 AND subscription.deleted_at IS NULL AND delivery.created_at>=?)`,
      [id, row.replay_count, plus(now, -webhookLimits.replayWindowSeconds)],
      [
        {
          sql: `UPDATE webhook_deliveries SET status='pending',cycle_attempts=0,replay_count=replay_count+1,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,last_status=NULL,failed_at=NULL,updated_at=? WHERE id=?`,
          params: [now, now, id],
        },
        ...audit('webhook_delivery.replayed', actor, now, {
          subscription_id: row.subscription_id,
          delivery_id: id,
          previous_status: row.status,
          last_status: row.last_status,
          last_error_code: row.last_error_code,
        }),
      ],
    )
    return (await delivery(id))!
  }
  const deliveriesSnapshot = async (filter: WebhookDeliveryFilter) => {
    const where = filterSql(filter)
    return (
      (
        await first<{ latest: string | null }>(
          client,
          `SELECT max(created_at) AS latest FROM webhook_deliveries WHERE ${where.where}`,
          where.params,
        )
      )?.latest ?? null
    )
  }
  const countDeliveries = async (filter: WebhookDeliveryFilter) => {
    const where = filterSql(filter)
    return (await first<{ total: number }>(
      client,
      `SELECT count(*) AS total FROM webhook_deliveries WHERE ${where.where}`,
      where.params,
    ))!.total
  }
  const pageDeliveries = async (window: WebhookDeliveryWindow) => {
    if (!Number.isSafeInteger(window.take) || window.take < 1 || window.take > 201)
      throw new WebhookError('invalid_webhook_page', 'per_page')
    const where = filterSql(window)
    const after = window.after ? ' AND (created_at<? OR (created_at=? AND id<?))' : ''
    return (
      await rows<DeliveryRow>(
        client,
        `SELECT * FROM webhook_deliveries WHERE ${where.where} AND created_at<=?${after} ORDER BY created_at DESC,id DESC LIMIT ?`,
        [
          ...where.params,
          window.createdThrough,
          ...(window.after
            ? [window.after.createdAt, window.after.createdAt, window.after.id]
            : []),
          window.take,
        ],
      )
    ).map(publicDelivery)
  }

  const processDue = async () => {
    const now = clock(),
      summary = { examined: 0, delivered: 0, retried: 0, failed: 0, contention: 0 }
    const reaped = await execute([
      {
        sql: `UPDATE webhook_deliveries SET status='failed',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,last_error_code='attempt_abandoned',failed_at=?,updated_at=?
        WHERE id IN(SELECT id FROM webhook_deliveries WHERE status='processing' AND lease_expires_at<=? AND cycle_attempts>=5 LIMIT 10) RETURNING id`,
        params: [now, now, now],
      },
    ])
    summary.failed += reaped[0]!.length
    const due = await rows<DeliveryRow>(
      client,
      `SELECT delivery.* FROM webhook_deliveries delivery JOIN webhook_subscriptions subscription ON subscription.id=delivery.subscription_id
      WHERE subscription.is_active=1 AND subscription.deleted_at IS NULL AND delivery.cycle_attempts<5
        AND ((delivery.status='pending' AND delivery.next_attempt_at<=?) OR (delivery.status='processing' AND delivery.lease_expires_at<=?))
      ORDER BY coalesce(delivery.next_attempt_at,delivery.lease_expires_at),delivery.created_at,delivery.id LIMIT ?`,
      [now, now, webhookLimits.deliveryBatch],
    )
    // Each endpoint has its own durable claim and outcome. Three slow endpoints cannot occupy the whole tick.
    let position = 0
    const handle = async () => {
      for (;;) {
        const candidate = due[position++]
        if (!candidate) return
        summary.examined++
        const token = crypto.randomUUID(),
          claimedAt = clock()
        const claimed = await execute([
          {
            sql: `UPDATE webhook_deliveries SET status='processing',attempt_count=attempt_count+1,cycle_attempts=cycle_attempts+1,lease_token=?,lease_expires_at=?,last_attempt_at=?,updated_at=?
            WHERE id=? AND cycle_attempts<5 AND ((status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_expires_at<=?))
              AND EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=webhook_deliveries.subscription_id AND is_active=1 AND deleted_at IS NULL) RETURNING *`,
            params: [
              token,
              plus(claimedAt, webhookLimits.deliveryLeaseSeconds),
              claimedAt,
              claimedAt,
              candidate.id,
              claimedAt,
              claimedAt,
            ],
          },
        ])
        const row = claimed[0]![0] as unknown as DeliveryRow | undefined
        if (!row) {
          summary.contention++
          continue
        }
        let status: number | null = null,
          error: WebhookDeliveryError | null = null,
          retryable = false
        try {
          const subscription = await privateSubscription(row.subscription_id)
          if (!subscription || subscription.deleted_at !== null)
            throw new WebhookError('webhook_subscription_deleted')
          if (!subscription.is_active) {
            // A pause after claim is not a failed HTTP attempt. Keep the original work for resume.
            const pausedAt = clock()
            await execute([
              {
                sql: `UPDATE webhook_deliveries SET status='pending',cycle_attempts=cycle_attempts-1,
                next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
                WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>?`,
                params: [pausedAt, pausedAt, row.id, token, pausedAt],
              },
            ])
            summary.contention++
            continue
          }
          const url = webhookUrl(subscription.url),
            cipher = vault(),
            keys = [
              await cipher.open(subscription.current_secret!, {
                subscriptionId: subscription.id,
                generation: subscription.generation,
              }),
            ]
          if (
            subscription.previous_secret &&
            subscription.previous_generation !== null &&
            subscription.previous_valid_until &&
            Date.parse(subscription.previous_valid_until) > Date.parse(clock())
          )
            keys.push(
              await cipher.open(subscription.previous_secret, {
                subscriptionId: subscription.id,
                generation: subscription.previous_generation,
              }),
            )
          try {
            const parsed = JSON.parse(row.payload_json) as {
              resource: { type: string; id: number; sequence: number }
              occurred_at: string
            }
            if (
              webhookBody({
                id: row.event_id,
                eventType: row.event_type,
                aggregateType: parsed.resource.type,
                aggregateId: parsed.resource.id,
                aggregateSequence: parsed.resource.sequence,
                occurredAt: parsed.occurred_at,
              }) !== row.payload_json
            )
              throw new WebhookError('invalid_webhook_event')
          } catch {
            throw new WebhookError('invalid_webhook_event')
          }
          const timestamp = Math.floor(Date.parse(clock()) / 1000)
          const signature = await webhookSignature({
            timestamp,
            body: row.payload_json,
            secrets: keys,
          })
          const signal = AbortSignal.timeout(webhookLimits.deliveryTimeoutMs)
          const send = options.transport.send({
            url,
            body: row.payload_json,
            eventId: row.event_id,
            timestamp: String(timestamp),
            signature,
            signal,
          })
          const response = await new Promise<{ status: number }>((resolve, reject) => {
            const timeout = () =>
              reject(new DOMException('Webhook request deadline exceeded', 'TimeoutError'))
            signal.addEventListener('abort', timeout, { once: true })
            send.then(resolve, reject).finally(() => signal.removeEventListener('abort', timeout))
          })
          if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
            throw new Error('Invalid transport status')
          status = response.status
          if (status < 200 || status >= 300) {
            error = status >= 300 && status < 400 ? 'redirect' : 'http_error'
            retryable = status >= 500 || [408, 425, 429].includes(status)
          }
        } catch (cause) {
          if (cause instanceof WebhookError) {
            error =
              cause.code === 'webhook_destination_forbidden' || cause.code === 'invalid_webhook_url'
                ? 'destination_forbidden'
                : cause.code === 'invalid_webhook_event'
                  ? 'invalid_payload'
                  : cause.code === 'webhook_subscription_deleted'
                    ? 'subscription_deleted'
                    : 'signing_secret_unavailable'
          } else {
            error =
              cause instanceof Error &&
              (cause.name === 'TimeoutError' || cause.name === 'AbortError')
                ? 'timeout'
                : 'network_error'
            retryable = true
          }
        }
        const finished = clock(),
          retry = error !== null && retryable && row.cycle_attempts < webhookLimits.maxAttempts
        const state = error === null ? 'delivered' : retry ? 'pending' : 'failed'
        const settled = await execute([
          {
            sql: `UPDATE webhook_deliveries SET status=?,last_status=?,last_error_code=?,next_attempt_at=?,delivered_at=?,failed_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>? RETURNING id`,
            params: [
              state,
              status,
              error,
              retry
                ? plus(finished, webhookLimits.retryDelaySeconds[row.cycle_attempts - 1]!)
                : null,
              state === 'delivered' ? finished : row.delivered_at,
              state === 'failed' ? finished : null,
              finished,
              row.id,
              token,
              finished,
            ],
          },
        ])
        if (!settled[0]!.length) summary.contention++
        else if (state === 'delivered') summary.delivered++
        else if (retry) summary.retried++
        else summary.failed++
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, due.length) }, () => handle()))
    return summary
  }
  const purge = async () => {
    const now = clock(),
      cutoff = plus(now, -webhookLimits.retentionDays * 86400)
    const result = await execute([
      {
        sql: `DELETE FROM webhook_deliveries WHERE id IN(SELECT id FROM webhook_deliveries WHERE created_at<? AND (status<>'processing' OR lease_expires_at<=?) ORDER BY created_at LIMIT 100) RETURNING id`,
        params: [cutoff, now],
      },
      {
        sql: `UPDATE webhook_subscriptions SET previous_secret=NULL,previous_generation=NULL,previous_valid_until=NULL WHERE previous_valid_until<=?`,
        params: [now],
      },
    ])
    return { removed: result[0]!.length }
  }
  return {
    configured: options.vault !== null,
    list,
    get,
    create,
    setActive,
    rotate,
    remove,
    delivery,
    replay,
    deliveriesSnapshot,
    countDeliveries,
    pageDeliveries,
    processDue,
    purge,
  }
}
