import type BetterSqlite3 from 'better-sqlite3'

export const ACTIVITY_LOG_SUBSCRIBER_ID = 'activity_log'

export const OUTBOX_DELIVERY_POLICY = {
  batchSize: 25,
  maxAttempts: 5,
  retryDelaySeconds: [60, 300, 900, 3_600] as const,
  handlerTimeoutMs: 5_000,
  attemptLeaseSeconds: 30,
} as const

export type OutboxDeliveryStatus = 'pending' | 'processing' | 'delivered' | 'failed'
export type OutboxDeliveryFailureCode = 'subscriber_timeout' | 'subscriber_rejected'

export interface OutboxEventRecord {
  id: string
  aggregateType: string
  aggregateId: number
  aggregateSequence: number
  eventType: string
  payload: Readonly<Record<string, unknown>>
  occurredAt: string
  availableAt: string
}

export interface OutboxDeliveryRecord {
  subscriberId: string
  eventId: string
  status: OutboxDeliveryStatus
  attemptCount: number
  nextAttemptAt: string | null
  lastErrorCode: OutboxDeliveryFailureCode | null
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

export interface ActivityLogRecord extends OutboxEventRecord {
  recordedAt: string
}

export interface OutboxSubscriberContext {
  idempotencyKey: string
  attemptId: string
  recordedAt: string
  signal: AbortSignal
}

export interface OutboxSubscriber {
  readonly id: string
  deliver(
    event: Readonly<OutboxEventRecord>,
    context: Readonly<OutboxSubscriberContext>,
  ): Promise<void>
}

export interface OutboxDrainSummary {
  examined: number
  delivered: number
  retried: number
  failed: number
  contention: number
}

export interface OutboxService {
  drain(limit?: number): Promise<OutboxDrainSummary>
  listActivity(input?: { limit?: number }): Promise<ActivityLogRecord[]>
  listDeliveries(input?: {
    status?: OutboxDeliveryStatus
    limit?: number
  }): Promise<OutboxDeliveryRecord[]>
  retryFailed(subscriberId: string, eventId: string): Promise<OutboxDeliveryRecord | null>
}

interface SqlOperation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  first<T>(query: string, bindings?: readonly unknown[]): Promise<T | null>
  all<T>(query: string, bindings?: readonly unknown[]): Promise<T[]>
  atomic(operations: readonly SqlOperation[]): Promise<Record<string, unknown>[][]>
}

interface OutboxEventRow {
  id: string
  aggregateType: string
  aggregateId: number
  aggregateSequence: number
  eventType: string
  payloadJson: string
  occurredAt: string
  availableAt: string
}

interface OutboxDeliveryRow {
  subscriberId: string
  eventId: string
  status: OutboxDeliveryStatus
  attemptCount: number
  nextAttemptAt: string | null
  lastErrorCode: OutboxDeliveryFailureCode | null
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

interface ActivityLogRow extends OutboxEventRow {
  recordedAt: string
}

export interface OutboxServiceOptions {
  now?: () => string
  createAttemptId?: () => string
  subscribers?: readonly OutboxSubscriber[]
  maxAttempts?: number
  retryDelaySeconds?: readonly number[]
  handlerTimeoutMs?: number
  attemptLeaseSeconds?: number
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const epoch = Date.parse(value)
  if (
    !canonicalTimestampPattern.test(value) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== value
  ) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
}

const assertIdentifier = (value: string, field: string): void => {
  if (!identifierPattern.test(value)) {
    throw new RangeError(`${field} must use 1-128 safe identifier characters`)
  }
}

const assertLimit = (value: number, maximum: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`)
  }
}

const eventColumns = `event.id, event.aggregate_type AS aggregateType,
  event.aggregate_id AS aggregateId, event.aggregate_sequence AS aggregateSequence,
  event.event_type AS eventType, event.payload_json AS payloadJson,
  event.occurred_at AS occurredAt, event.available_at AS availableAt`

const deliveryColumns = `receipt.subscriber_id AS subscriberId,
  receipt.event_id AS eventId, receipt.status, receipt.attempt_count AS attemptCount,
  receipt.next_attempt_at AS nextAttemptAt, receipt.last_error_code AS lastErrorCode,
  receipt.delivered_at AS deliveredAt, receipt.failed_at AS failedAt,
  receipt.created_at AS createdAt, receipt.updated_at AS updatedAt,
  event.event_type AS eventType, event.aggregate_type AS aggregateType,
  event.aggregate_id AS aggregateId, event.aggregate_sequence AS aggregateSequence,
  event.occurred_at AS occurredAt`

const eventRecord = (row: OutboxEventRow): OutboxEventRecord => {
  let payload: unknown
  try {
    payload = JSON.parse(row.payloadJson)
  } catch {
    throw new Error(`outbox event ${row.id} contains malformed payload JSON`)
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`outbox event ${row.id} payload must be an object`)
  }
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    aggregateSequence: row.aggregateSequence,
    eventType: row.eventType,
    payload: payload as Record<string, unknown>,
    occurredAt: row.occurredAt,
    availableAt: row.availableAt,
  }
}

const deliveryRecord = (row: OutboxDeliveryRow): OutboxDeliveryRecord => ({
  ...row,
})

const safeAddSeconds = (timestamp: string, seconds: number): string => {
  const epoch = Date.parse(timestamp) + seconds * 1_000
  if (!Number.isSafeInteger(epoch)) throw new RangeError('outbox retry timestamp is out of range')
  return new Date(epoch).toISOString()
}

const validatePolicy = (
  maxAttempts: number,
  retryDelaySeconds: readonly number[],
  handlerTimeoutMs: number,
  attemptLeaseSeconds: number,
): void => {
  assertLimit(maxAttempts, 100, 'outbox maximum attempts')
  if (
    retryDelaySeconds.length !== maxAttempts - 1 ||
    retryDelaySeconds.some(
      (delay) => !Number.isSafeInteger(delay) || delay < 1 || delay > 604_800,
    )
  ) {
    throw new RangeError('outbox retry policy must define one bounded delay per retry')
  }
  assertLimit(handlerTimeoutMs, 300_000, 'outbox subscriber timeout')
  assertLimit(attemptLeaseSeconds, 3_600, 'outbox attempt lease')
  if (attemptLeaseSeconds * 1_000 <= handlerTimeoutMs) {
    throw new RangeError('outbox attempt lease must exceed the subscriber timeout')
  }
}

const candidate = async (
  database: PortableDatabase,
  subscriberId: string,
  at: string,
): Promise<OutboxEventRow | null> =>
  database.first<OutboxEventRow>(
    `SELECT ${eventColumns}
     FROM event_outbox event
     LEFT JOIN outbox_delivery_receipts receipt
       ON receipt.subscriber_id = ? AND receipt.event_id = event.id
     WHERE event.published_at IS NULL
       AND julianday(event.available_at) <= julianday(?)
       AND (
         receipt.event_id IS NULL
         OR (receipt.status = 'pending' AND (
           receipt.next_attempt_at IS NULL
           OR julianday(receipt.next_attempt_at) <= julianday(?)
         ))
         OR (receipt.status = 'processing'
           AND julianday(receipt.attempt_lease_expires_at) <= julianday(?))
       )
       AND NOT EXISTS (
         SELECT 1 FROM event_outbox prior
         WHERE prior.aggregate_type = event.aggregate_type
           AND prior.aggregate_id = event.aggregate_id
           AND prior.aggregate_sequence < event.aggregate_sequence
           AND prior.published_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM outbox_delivery_receipts prior_receipt
             WHERE prior_receipt.subscriber_id = ?
               AND prior_receipt.event_id = prior.id
               AND prior_receipt.status = 'delivered'
           )
       )
     ORDER BY event.available_at, event.occurred_at, event.id
     LIMIT 1`,
    [subscriberId, at, at, at, subscriberId],
  )

const claim = async (
  database: PortableDatabase,
  subscriberId: string,
  eventId: string,
  attemptId: string,
  at: string,
  leaseExpiresAt: string,
  maxAttempts: number,
): Promise<number | 'expired-terminal' | null> => {
  const results = await database.atomic([
    {
      query: `INSERT INTO outbox_delivery_receipts (
          subscriber_id, event_id, status, attempt_count, created_at, updated_at
        )
        SELECT ?, event.id, 'pending', 0, ?, ?
        FROM event_outbox event
        WHERE event.id = ? AND event.published_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM outbox_delivery_receipts current
            WHERE current.subscriber_id = ? AND current.event_id = event.id
          )`,
      bindings: [subscriberId, at, at, eventId, subscriberId],
    },
    {
      query: `UPDATE outbox_delivery_receipts AS receipt
        SET status = 'processing', attempt_count = attempt_count + 1,
          next_attempt_at = NULL, active_attempt_id = ?,
          attempt_lease_expires_at = ?, failed_at = NULL, updated_at = ?
        WHERE receipt.subscriber_id = ? AND receipt.event_id = ?
          AND receipt.attempt_count < ?
          AND (
            (receipt.status = 'pending' AND (
              receipt.next_attempt_at IS NULL
              OR julianday(receipt.next_attempt_at) <= julianday(?)
            ))
            OR (receipt.status = 'processing'
              AND julianday(receipt.attempt_lease_expires_at) <= julianday(?))
          )
          AND EXISTS (
            SELECT 1 FROM event_outbox event
            WHERE event.id = receipt.event_id AND event.published_at IS NULL
              AND julianday(event.available_at) <= julianday(?)
              AND NOT EXISTS (
                SELECT 1 FROM event_outbox prior
                WHERE prior.aggregate_type = event.aggregate_type
                  AND prior.aggregate_id = event.aggregate_id
                  AND prior.aggregate_sequence < event.aggregate_sequence
                  AND prior.published_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM outbox_delivery_receipts prior_receipt
                    WHERE prior_receipt.subscriber_id = receipt.subscriber_id
                      AND prior_receipt.event_id = prior.id
                      AND prior_receipt.status = 'delivered'
                  )
              )
          )
        RETURNING attempt_count AS attemptCount`,
      bindings: [
        attemptId,
        leaseExpiresAt,
        at,
        subscriberId,
        eventId,
        maxAttempts,
        at,
        at,
        at,
      ],
    },
    {
      query: `UPDATE outbox_delivery_receipts
        SET status = 'failed', active_attempt_id = NULL,
          attempt_lease_expires_at = NULL, last_error_code = 'subscriber_timeout',
          failed_at = ?, updated_at = ?
        WHERE subscriber_id = ? AND event_id = ? AND attempt_count >= ?
          AND (
            (status = 'pending' AND (
              next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)
            ))
            OR (status = 'processing'
              AND julianday(attempt_lease_expires_at) <= julianday(?))
          )
        RETURNING event_id AS eventId`,
      bindings: [at, at, subscriberId, eventId, maxAttempts, at, at],
    },
    {
      query: `UPDATE event_outbox
        SET attempt_count = attempt_count + 1
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM outbox_delivery_receipts receipt
          WHERE receipt.subscriber_id = ? AND receipt.event_id = event_outbox.id
            AND receipt.status = 'processing' AND receipt.active_attempt_id = ?
        )`,
      bindings: [eventId, subscriberId, attemptId],
    },
    {
      query: `UPDATE event_outbox SET last_error = 'subscriber_timeout'
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM outbox_delivery_receipts receipt
          WHERE receipt.subscriber_id = ? AND receipt.event_id = event_outbox.id
            AND receipt.status = 'failed'
            AND receipt.last_error_code = 'subscriber_timeout'
            AND receipt.updated_at = ?
        )`,
      bindings: [eventId, subscriberId, at],
    },
  ])
  const row = results[1]?.[0]
  if (typeof row?.attemptCount === 'number') return row.attemptCount
  return results[2]?.[0]?.eventId === eventId ? 'expired-terminal' : null
}

const callSubscriber = async (
  subscriber: OutboxSubscriber,
  event: OutboxEventRecord,
  context: Omit<OutboxSubscriberContext, 'signal'>,
  timeoutMs: number,
): Promise<OutboxDeliveryFailureCode | null> => {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new DOMException('outbox subscriber timed out', 'TimeoutError'))
    }, timeoutMs)
  })
  try {
    await Promise.race([
      subscriber.deliver(event, { ...context, signal: controller.signal }),
      timedOut,
    ])
    return null
  } catch (error) {
    return error instanceof DOMException && error.name === 'TimeoutError'
      ? 'subscriber_timeout'
      : 'subscriber_rejected'
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const createActivitySubscriber = (database: PortableDatabase): OutboxSubscriber => ({
  id: ACTIVITY_LOG_SUBSCRIBER_ID,
  async deliver(event, context) {
    if (context.signal.aborted) {
      throw new DOMException('outbox subscriber aborted', 'AbortError')
    }
    await database.atomic([
      {
        query: `INSERT INTO activity_log (event_id, recorded_at)
          SELECT ?, ? WHERE EXISTS (SELECT 1 FROM event_outbox WHERE id = ?)
            AND NOT EXISTS (SELECT 1 FROM activity_log WHERE event_id = ?)`,
        bindings: [event.id, context.recordedAt, event.id, event.id],
      },
    ])
  },
})

const finalizeDelivered = async (
  database: PortableDatabase,
  subscriberIds: readonly string[],
  subscriberId: string,
  eventId: string,
  attemptId: string,
  at: string,
): Promise<boolean> => {
  const placeholders = subscriberIds.map(() => '?').join(',')
  const results = await database.atomic([
    {
      query: `UPDATE outbox_delivery_receipts
        SET status = 'delivered', active_attempt_id = NULL,
          attempt_lease_expires_at = NULL, last_error_code = NULL,
          delivered_at = ?, failed_at = NULL, updated_at = ?
        WHERE subscriber_id = ? AND event_id = ?
          AND status = 'processing' AND active_attempt_id = ?
        RETURNING event_id AS eventId`,
      bindings: [at, at, subscriberId, eventId, attemptId],
    },
    {
      query: `UPDATE event_outbox
        SET published_at = COALESCE(published_at, ?), last_error = NULL
        WHERE id = ? AND published_at IS NULL
          AND (SELECT count(*) FROM outbox_delivery_receipts receipt
            WHERE receipt.event_id = event_outbox.id
              AND receipt.subscriber_id IN (${placeholders})
              AND receipt.status = 'delivered') = ?`,
      bindings: [at, eventId, ...subscriberIds, subscriberIds.length],
    },
  ])
  return results[0]?.[0]?.eventId === eventId
}

const finalizeFailure = async (
  database: PortableDatabase,
  subscriberId: string,
  eventId: string,
  attemptId: string,
  attemptCount: number,
  failureCode: OutboxDeliveryFailureCode,
  at: string,
  maxAttempts: number,
  retryDelaySeconds: readonly number[],
): Promise<'retry' | 'failed' | 'stale'> => {
  const terminal = attemptCount >= maxAttempts
  const nextAttemptAt = terminal
    ? null
    : safeAddSeconds(at, retryDelaySeconds[attemptCount - 1]!)
  const results = await database.atomic([
    {
      query: `UPDATE outbox_delivery_receipts
        SET status = ?, next_attempt_at = ?, active_attempt_id = NULL,
          attempt_lease_expires_at = NULL, last_error_code = ?,
          failed_at = ?, updated_at = ?
        WHERE subscriber_id = ? AND event_id = ?
          AND status = 'processing' AND active_attempt_id = ?
        RETURNING status`,
      bindings: [
        terminal ? 'failed' : 'pending',
        nextAttemptAt,
        failureCode,
        terminal ? at : null,
        at,
        subscriberId,
        eventId,
        attemptId,
      ],
    },
    {
      query: `UPDATE event_outbox SET last_error = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM outbox_delivery_receipts receipt
          WHERE receipt.subscriber_id = ? AND receipt.event_id = event_outbox.id
            AND receipt.last_error_code = ? AND receipt.updated_at = ?
        )`,
      bindings: [failureCode, eventId, subscriberId, failureCode, at],
    },
  ])
  const status = results[0]?.[0]?.status
  return status === 'failed' ? 'failed' : status === 'pending' ? 'retry' : 'stale'
}

const createService = (
  database: PortableDatabase,
  options: OutboxServiceOptions,
): OutboxService => {
  const now = options.now ?? (() => new Date().toISOString())
  const createAttemptId = options.createAttemptId ?? (() => crypto.randomUUID())
  const maxAttempts = options.maxAttempts ?? OUTBOX_DELIVERY_POLICY.maxAttempts
  const retryDelaySeconds =
    options.retryDelaySeconds ?? OUTBOX_DELIVERY_POLICY.retryDelaySeconds
  const handlerTimeoutMs =
    options.handlerTimeoutMs ?? OUTBOX_DELIVERY_POLICY.handlerTimeoutMs
  const attemptLeaseSeconds =
    options.attemptLeaseSeconds ?? OUTBOX_DELIVERY_POLICY.attemptLeaseSeconds
  validatePolicy(
    maxAttempts,
    retryDelaySeconds,
    handlerTimeoutMs,
    attemptLeaseSeconds,
  )
  const subscribers = options.subscribers ?? [createActivitySubscriber(database)]
  if (subscribers.length < 1 || subscribers.length > 100) {
    throw new RangeError('outbox subscriber registry must contain between 1 and 100 entries')
  }
  const subscriberIds = subscribers.map(({ id }) => id)
  for (const id of subscriberIds) assertIdentifier(id, 'outbox subscriber id')
  if (new Set(subscriberIds).size !== subscriberIds.length) {
    throw new RangeError('outbox subscriber ids must be unique')
  }

  const timestamp = (): string => {
    const at = now()
    assertCanonicalTimestamp(at, 'outbox clock')
    return at
  }

  return {
    async drain(limit = OUTBOX_DELIVERY_POLICY.batchSize) {
      assertLimit(limit, 100, 'outbox drain limit')
      const summary: OutboxDrainSummary = {
        examined: 0,
        delivered: 0,
        retried: 0,
        failed: 0,
        contention: 0,
      }
      let subscriberIndex = 0
      while (summary.examined < limit) {
        let selected:
          | { subscriber: OutboxSubscriber; row: OutboxEventRow }
          | undefined
        for (let offset = 0; offset < subscribers.length; offset += 1) {
          const index = (subscriberIndex + offset) % subscribers.length
          const subscriber = subscribers[index]!
          const at = timestamp()
          const row = await candidate(database, subscriber.id, at)
          if (row !== null) {
            selected = { subscriber, row }
            subscriberIndex = (index + 1) % subscribers.length
            break
          }
        }
        if (selected === undefined) break

        summary.examined += 1
        const at = timestamp()
        const attemptId = createAttemptId()
        assertIdentifier(attemptId, 'outbox attempt id')
        const attemptCount = await claim(
          database,
          selected.subscriber.id,
          selected.row.id,
          attemptId,
          at,
          safeAddSeconds(at, attemptLeaseSeconds),
          maxAttempts,
        )
        if (attemptCount === 'expired-terminal') {
          summary.failed += 1
          continue
        }
        if (attemptCount === null) {
          summary.contention += 1
          continue
        }
        let event: OutboxEventRecord
        try {
          event = eventRecord(selected.row)
        } catch {
          const disposition = await finalizeFailure(
            database,
            selected.subscriber.id,
            selected.row.id,
            attemptId,
            attemptCount,
            'subscriber_rejected',
            timestamp(),
            maxAttempts,
            retryDelaySeconds,
          )
          if (disposition === 'retry') summary.retried += 1
          else if (disposition === 'failed') summary.failed += 1
          else summary.contention += 1
          continue
        }
        const failure = await callSubscriber(
          selected.subscriber,
          event,
          {
            attemptId,
            idempotencyKey: `${selected.subscriber.id}:${event.id}`,
            recordedAt: at,
          },
          handlerTimeoutMs,
        )
        const completedAt = timestamp()
        if (failure === null) {
          if (
            await finalizeDelivered(
              database,
              subscriberIds,
              selected.subscriber.id,
              event.id,
              attemptId,
              completedAt,
            )
          ) {
            summary.delivered += 1
          } else {
            summary.contention += 1
          }
          continue
        }

        const disposition = await finalizeFailure(
          database,
          selected.subscriber.id,
          event.id,
          attemptId,
          attemptCount,
          failure,
          completedAt,
          maxAttempts,
          retryDelaySeconds,
        )
        if (disposition === 'retry') summary.retried += 1
        else if (disposition === 'failed') summary.failed += 1
        else summary.contention += 1
      }
      return summary
    },

    async listActivity(input = {}) {
      const limit = input.limit ?? 100
      assertLimit(limit, 200, 'activity log limit')
      const rows = await database.all<ActivityLogRow>(
        `SELECT ${eventColumns}, activity.recorded_at AS recordedAt
         FROM activity_log activity
         JOIN event_outbox event ON event.id = activity.event_id
         ORDER BY activity.recorded_at DESC, activity.event_id DESC
         LIMIT ?`,
        [limit],
      )
      return rows.map((row) => ({ ...eventRecord(row), recordedAt: row.recordedAt }))
    },

    async listDeliveries(input = {}) {
      const limit = input.limit ?? 100
      assertLimit(limit, 200, 'outbox delivery limit')
      const status = input.status
      return (
        await database.all<OutboxDeliveryRow>(
          `SELECT ${deliveryColumns}
           FROM outbox_delivery_receipts receipt
           JOIN event_outbox event ON event.id = receipt.event_id
           ${status === undefined ? '' : 'WHERE receipt.status = ?'}
           ORDER BY receipt.updated_at DESC, receipt.subscriber_id, receipt.event_id
           LIMIT ?`,
          status === undefined ? [limit] : [status, limit],
        )
      ).map(deliveryRecord)
    },

    async retryFailed(subscriberId, eventId) {
      assertIdentifier(subscriberId, 'outbox subscriber id')
      if (!subscriberIds.includes(subscriberId)) return null
      if (typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 512) {
        throw new RangeError('outbox event id must contain between 1 and 512 characters')
      }
      const at = timestamp()
      const row = await database.first<OutboxDeliveryRow>(
        `UPDATE outbox_delivery_receipts
         SET status = 'pending', attempt_count = 0, next_attempt_at = ?,
           last_error_code = NULL, failed_at = NULL, updated_at = ?
         WHERE subscriber_id = ? AND event_id = ? AND status = 'failed'
         RETURNING subscriber_id AS subscriberId, event_id AS eventId, status,
           attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
           last_error_code AS lastErrorCode, delivered_at AS deliveredAt,
           failed_at AS failedAt, created_at AS createdAt, updated_at AS updatedAt,
           (SELECT event_type FROM event_outbox WHERE id = event_id) AS eventType,
           (SELECT aggregate_type FROM event_outbox WHERE id = event_id) AS aggregateType,
           (SELECT aggregate_id FROM event_outbox WHERE id = event_id) AS aggregateId,
           (SELECT aggregate_sequence FROM event_outbox WHERE id = event_id) AS aggregateSequence,
           (SELECT occurred_at FROM event_outbox WHERE id = event_id) AS occurredAt`,
        [at, at, subscriberId, eventId],
      )
      return row === null ? null : deliveryRecord(row)
    },
  }
}

const containerAdapter = (database: BetterSqlite3.Database): PortableDatabase => ({
  first: async <T>(query: string, bindings: readonly unknown[] = []) =>
    (database.prepare(query).get(...bindings) as T | undefined) ?? null,
  all: async <T>(query: string, bindings: readonly unknown[] = []) =>
    database.prepare(query).all(...bindings) as T[],
  atomic: async (operations) =>
    database.transaction(() =>
      operations.map(({ query, bindings }) => {
        const statement = database.prepare(query)
        if (statement.reader) return statement.all(...bindings) as Record<string, unknown>[]
        statement.run(...bindings)
        return []
      }),
    )(),
})

const d1Adapter = (database: D1Database): PortableDatabase => ({
  first: async <T>(query: string, bindings: readonly unknown[] = []) =>
    database
      .prepare(query)
      .bind(...bindings)
      .first<T>(),
  all: async <T>(query: string, bindings: readonly unknown[] = []) =>
    (
      await database
        .prepare(query)
        .bind(...bindings)
        .all<T>()
    ).results,
  atomic: async (operations) =>
    (
      await database.batch(
        operations.map(({ query, bindings }) =>
          database
            .prepare(query)
            .bind(...bindings),
        ),
      )
    ).map((result) => result.results as Record<string, unknown>[]),
})

export const createContainerOutboxService = (
  database: BetterSqlite3.Database,
  options: OutboxServiceOptions = {},
): OutboxService => {
  database.pragma('foreign_keys = ON')
  return createService(containerAdapter(database), options)
}

export const createD1OutboxService = (
  database: D1Database,
  options: OutboxServiceOptions = {},
): OutboxService => createService(d1Adapter(database), options)
