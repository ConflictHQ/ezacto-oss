import type BetterSqlite3 from 'better-sqlite3'
import { accountClosureDigest, closedAccountProviderKey } from './account-closure-sign-in.js'
import { aggregateAppleCleanup, type AppleCleanupStatus } from '@ezacto/core'

import type { AppleWebConnection, AppleWebCustodyStore } from '@ezacto/core'
export type { AppleWebConnection, AppleWebCustodyStore } from '@ezacto/core'

interface Operation { query: string; bindings: readonly unknown[] }
interface Database { atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]> }
const columns = `id, subject_digest AS subjectDigest, browser_hash AS browserHash,
  user_id AS userId, service_issuer AS serviceIssuer, instance_origin AS instanceOrigin,
  client_id AS clientId, grant_id AS grantId, generation, sealed_capability AS sealedCapability,
  sealed_receipt AS sealedReceipt, cleanup_request_id AS cleanupRequestId, status, created_at AS createdAt, updated_at AS updatedAt`
const row = (value: Record<string, unknown> | undefined): AppleWebConnection | null => value === undefined ? null : value as unknown as AppleWebConnection
const opaque = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new TypeError('Invalid Apple custody identifier')
  return value
}
const digest = (value: string): string => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid Apple custody digest')
  return value
}
const timestamp = (value: string): string => {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Invalid Apple custody timestamp')
  return value
}
const createStore = (db: Database): AppleWebCustodyStore => ({
  async save(input, identity) {
    opaque(input.id); digest(input.subjectDigest); digest(input.browserHash); opaque(input.grantId)
    timestamp(input.createdAt); timestamp(input.updatedAt)
    if (input.status !== 'active' || input.sealedCapability === null || !Number.isSafeInteger(input.generation) || input.generation < 1) throw new TypeError('Invalid Apple custody grant')
    if (input.cleanupRequestId !== null) opaque(input.cleanupRequestId)
    if (input.userId !== null && (identity === undefined || !identity.subject || identity.subject.length > 255)) throw new TypeError('Verified Apple identity required for team custody')
    let channelDigest: string | null = null
    if (input.userId !== null && identity !== undefined) {
      const security = await db.atomic([{ query: 'SELECT secret FROM account_closure_security WHERE id = 1', bindings: [] }])
      const secret = security[0]?.[0]?.secret
      if (typeof secret !== 'string') throw new Error('Missing account closure security configuration')
      channelDigest = accountClosureDigest(secret, 'provider', closedAccountProviderKey('apple', identity.subject))
    }
    const rows = await db.atomic([{ query: `INSERT INTO apple_web_connections (${columns.replace(/ AS [A-Za-z]+/g, '')})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (? IS NULL OR (EXISTS(SELECT 1 FROM users WHERE id = ? AND is_active = 1)
        AND NOT EXISTS(SELECT 1 FROM apple_web_cleanup_requests WHERE user_id = ?)
        AND EXISTS(SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'apple' AND provider_subject = ?)))
        AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM apple_web_cleanup_requests WHERE request_id = ?)
          OR EXISTS(SELECT 1 FROM apple_web_cleanup_obligations obligation JOIN apple_web_connections custody ON custody.id = obligation.connection_id
            WHERE obligation.request_id = ? AND custody.subject_digest = ? AND custody.service_issuer = ? AND custody.instance_origin = ? AND custody.client_id = ?))
      ON CONFLICT(subject_digest, service_issuer, instance_origin, client_id) WHERE status != 'revoked' DO UPDATE SET
        browser_hash = excluded.browser_hash, user_id = coalesce(excluded.user_id, apple_web_connections.user_id),
        grant_id = excluded.grant_id, generation = excluded.generation, sealed_capability = excluded.sealed_capability,
        cleanup_request_id = coalesce(apple_web_connections.cleanup_request_id, excluded.cleanup_request_id),
        status = 'active', updated_at = excluded.updated_at
      WHERE apple_web_connections.generation < excluded.generation
        AND (apple_web_connections.user_id IS NULL OR excluded.user_id IS NULL OR apple_web_connections.user_id = excluded.user_id)
        AND (apple_web_connections.cleanup_request_id IS NULL OR apple_web_connections.cleanup_request_id = excluded.cleanup_request_id)
      RETURNING ${columns}`, bindings: [input.id, input.subjectDigest, input.browserHash, input.userId,
      input.serviceIssuer, input.instanceOrigin, input.clientId, input.grantId, input.generation,
      input.sealedCapability, input.sealedReceipt, input.cleanupRequestId, input.status, input.createdAt, input.updatedAt, input.userId, input.userId, input.userId, input.userId, identity?.subject ?? null,
      input.cleanupRequestId, input.cleanupRequestId, input.cleanupRequestId, input.subjectDigest, input.serviceIssuer, input.instanceOrigin, input.clientId] },
      { query: `UPDATE apple_web_cleanup_obligations SET grant_id = ?, generation = ?, status = 'pending', updated_at = ?
        WHERE request_id = ? AND status != 'revoked' AND generation < ? AND connection_id IN
          (SELECT id FROM apple_web_connections WHERE subject_digest = ? AND service_issuer = ? AND instance_origin = ? AND client_id = ?
           AND generation = ? AND cleanup_request_id = ? AND status = 'active')`,
        bindings: [input.grantId, input.generation, input.updatedAt, input.cleanupRequestId, input.generation,
          input.subjectDigest, input.serviceIssuer, input.instanceOrigin, input.clientId, input.generation, input.cleanupRequestId] },
      { query: `INSERT INTO apple_identity_channels(subject_hash, user_id, channel, known_from_first_link)
        SELECT ?, user_id, 'web', ? FROM apple_web_connections
        WHERE browser_hash = ? AND user_id = ? AND grant_id = ? AND generation = ? AND status = 'active'
        ON CONFLICT DO NOTHING`, bindings: [channelDigest, identity?.knownFromFirstLink === true ? 1 : 0,
          input.browserHash, input.userId, input.grantId, input.generation] },
    ])
    return row(rows[0]?.[0])
  },
  async browser(hash) {
    const rows = await db.atomic([{ query: `SELECT ${columns} FROM apple_web_connections WHERE browser_hash = ? AND status != 'revoked'`, bindings: [digest(hash)] }])
    return row(rows[0]?.[0])
  },
  async begin(userId, requestId, now) {
    opaque(requestId); timestamp(now)
    if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('Invalid Apple custody user')
    const rows = await db.atomic([
      { query: `INSERT INTO apple_web_cleanup_requests(request_id, user_id, captured_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, bindings: [requestId, userId, now] },
      { query: `INSERT INTO apple_web_cleanup_obligations(request_id, connection_id, grant_id, generation, status, updated_at)
        SELECT ?, id, grant_id, generation, CASE WHEN cleanup_request_id IS NOT NULL AND cleanup_request_id != ? THEN 'manual_required' ELSE 'pending' END, ?
        FROM apple_web_connections WHERE user_id = ? AND status != 'revoked'
          AND EXISTS(SELECT 1 FROM apple_web_cleanup_requests WHERE request_id = ? AND user_id = ?)
        ON CONFLICT DO NOTHING`, bindings: [requestId, requestId, now, userId, requestId, userId] },
      { query: `UPDATE apple_web_connections SET cleanup_request_id = coalesce(cleanup_request_id, ?),
        status = CASE WHEN cleanup_request_id IS NOT NULL AND cleanup_request_id != ? THEN 'manual_required' ELSE 'pending' END, updated_at = ?
        WHERE user_id = ? AND status != 'revoked' AND EXISTS(SELECT 1 FROM apple_web_cleanup_requests WHERE request_id = ? AND user_id = ?)`, bindings: [requestId, requestId, now, userId, requestId, userId] },
      { query: `SELECT user_id FROM apple_web_cleanup_requests WHERE request_id = ?`, bindings: [requestId] },
    ])
    if (rows[3]?.[0]?.user_id !== userId) throw new TypeError('Apple cleanup request belongs to another user')
  },
  async obligations(requestId) {
    const rows = await db.atomic([{ query: `SELECT ${columns} FROM apple_web_connections WHERE id IN
      (SELECT connection_id FROM apple_web_cleanup_obligations WHERE request_id = ? AND status != 'revoked')`, bindings: [opaque(requestId)] }])
    return rows[0]!.map(value => row(value)!)
  },
  async requestExists(requestId) {
    const rows = await db.atomic([{ query: 'SELECT request_id FROM apple_web_cleanup_requests WHERE request_id = ?', bindings: [opaque(requestId)] }])
    return rows[0]?.length === 1
  },
  async status(requestId) {
    const rows = await db.atomic([
      { query: `SELECT request_id FROM apple_web_cleanup_requests WHERE request_id = ?`, bindings: [opaque(requestId)] },
      { query: `SELECT status FROM apple_web_cleanup_obligations WHERE request_id = ?`, bindings: [requestId] },
    ])
    if (rows[0]?.length !== 1) return 'manual_required'
    return aggregateAppleCleanup(rows[1]!.map(value => value.status as AppleCleanupStatus))
  },
  async pending(id, requestId, now) {
    const rows = await db.atomic([{ query: `UPDATE apple_web_connections SET cleanup_request_id = ?, status = 'pending', updated_at = ?
      WHERE id = ? AND status IN ('active', 'pending', 'manual_required') AND (cleanup_request_id IS NULL OR cleanup_request_id = ?)
      RETURNING id`, bindings: [opaque(requestId), timestamp(now), opaque(id), requestId] }])
    return rows[0]?.length === 1
  },
  async manual(id, now) {
    await db.atomic([
      { query: `UPDATE apple_web_connections SET status = 'manual_required', updated_at = ? WHERE id = ? AND status != 'revoked'`, bindings: [timestamp(now), opaque(id)] },
      { query: `UPDATE apple_web_cleanup_obligations SET status = 'manual_required', updated_at = ? WHERE connection_id = ? AND status != 'revoked'`, bindings: [now, id] },
    ])
  },
  async complete(input) {
    opaque(input.id); opaque(input.requestId); opaque(input.grantId); timestamp(input.now)
    const rows = await db.atomic([
      { query: `UPDATE apple_web_connections SET status = 'revoked', sealed_capability = NULL, sealed_receipt = ?, updated_at = ?
        WHERE id = ? AND cleanup_request_id = ? AND grant_id = ? AND generation = ? RETURNING id`,
        bindings: [input.sealedReceipt, input.now, input.id, input.requestId, input.grantId, input.generation] },
      { query: `UPDATE apple_web_cleanup_obligations SET status = 'revoked', sealed_receipt = ?, updated_at = ?
        WHERE connection_id = ? AND request_id = ? AND grant_id = ? AND generation = ?
          AND EXISTS(SELECT 1 FROM apple_web_connections WHERE id = ? AND status = 'revoked' AND cleanup_request_id = ? AND grant_id = ? AND generation = ?)`,
        bindings: [input.sealedReceipt, input.now, input.id, input.requestId, input.grantId, input.generation,
          input.id, input.requestId, input.grantId, input.generation] },
    ])
    return rows[0]?.length === 1
  },
})

export const createContainerAppleWebCustodyStore = (database: BetterSqlite3.Database): AppleWebCustodyStore => createStore({
  atomic: async operations => database.transaction(() => operations.map(({ query, bindings }) => {
    const statement = database.prepare(query)
    if (statement.reader) return statement.all(...bindings) as Record<string, unknown>[]
    statement.run(...bindings); return []
  }))(),
})
export const createD1AppleWebCustodyStore = (database: D1Database): AppleWebCustodyStore => createStore({
  atomic: async operations => (await database.batch(operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings))))
    .map(result => result.results as Record<string, unknown>[]),
})
