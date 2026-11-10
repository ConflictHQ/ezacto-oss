import type {
  ManagedQuickBooksWriteStore, QuickBooksWriteConnection, QuickBooksWriteSource,
  QuickBooksWritePlan, QuickBooksStoredWrite,
} from '@ezacto/integrations'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { atomicStatements } from './atomic-statements.js'
import { encodeWritePayload, readWritePayload } from './quickbooks-write-payload.js'

type Row = Record<string, unknown>
interface Effect extends Row {
  id: string; request_id: string; generation: number; realm_id: string; connected_at: string
  resource: string; native_id: number; source_hash: string; operation: string; payload_hash: string
  body_hash: string; body_bytes: number; body_chunks: number; path: QuickBooksStoredWrite['path']; minor_version: string
  state: string; owner_id: string | null; owner_expires_at: string | null; result_attempt_id: string | null
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const iso = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const validConnection = (connection: QuickBooksWriteConnection) => Number.isSafeInteger(connection.connectionGeneration)
  && connection.connectionGeneration >= 0 && Boolean(connection.realmId) && iso(connection.connectedAt)
const validate = (source: QuickBooksWriteSource, ownerId: string, now: string, leaseUntil: string) => {
  if (!uuid.test(ownerId) || !iso(now) || !iso(leaseUntil) || leaseUntil <= now || !positive(source.nativeId)
    || !positive(source.invoiceId) || typeof source.invoiceVersion !== 'number' || !Number.isSafeInteger(source.invoiceVersion)
    || source.invoiceVersion < 0 || !/^[a-f0-9]{64}$/.test(source.sourceHash)
    || !['customer','invoice','payment'].includes(source.resource)) throw new Error('Invalid managed QuickBooks write command')
}
const current = (alias: string) => `EXISTS(SELECT 1 FROM quickbooks_connections c
  JOIN quickbooks_connection_generation generation ON generation.singleton=1
  JOIN quickbooks_managed_grants grant_receipt ON grant_receipt.realm_id=c.realm_id
    AND grant_receipt.recorded_at=c.connected_at AND grant_receipt.accepted_generation=generation.generation
  WHERE c.id=1 AND c.disconnected_at IS NULL AND c.realm_id=${alias}.realm_id AND c.connected_at=${alias}.connected_at
    AND generation.generation=${alias}.generation)
  AND NOT EXISTS(SELECT 1 FROM quickbooks_revocations WHERE status<>'revoked')
  AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))`
const invoiceCurrent = (alias: string) => `EXISTS(SELECT 1 FROM invoices i WHERE i.id=${alias}.owner_invoice_id
  AND i.version=${alias}.owner_invoice_version AND i.state IN ('open','paid'))`
const unavailable: QuickBooksWritePlan = { kind: 'unavailable' }

/** Bind only an independently durable native database. Every provider call is
 * outside these atomic operations; no token/header is admitted into the ledger.
 */
export const createManagedQuickBooksWriteStore = (database: InvoiceStateDatabase): ManagedQuickBooksWriteStore => {
  const query = async (text: string, params: readonly unknown[] = []): Promise<Row[]> =>
    (await atomicStatements(database, [{ text, params }]))[0] ?? []
  const effect = async (id: string) => (await query('SELECT * FROM quickbooks_write_effects WHERE id=?', [id]))[0] as Effect | undefined
  const response = async (attemptId: string): Promise<string> => {
    const a = (await query("SELECT * FROM quickbooks_write_attempts WHERE id=? AND state='observed'", [attemptId]))[0]
    if (!a) throw new Error('Incomplete managed QuickBooks write result')
    return readWritePayload(database, { direction: 'response', id: attemptId, hash: a.response_hash as string,
      bytes: a.response_bytes as number, chunks: a.response_chunks as number })
  }
  const safeCompleted = async (e: Effect): Promise<QuickBooksWritePlan> => {
    if (e.state !== 'completed' || !e.result_attempt_id || !(await query(`SELECT e.id FROM quickbooks_write_effects e WHERE e.id=? AND ${current('e')}`, [e.id])).length) return unavailable
    return { kind: 'completed', response: await response(e.result_attempt_id) }
  }
  const claim = async (e: Effect, source: QuickBooksWriteSource, ownerId: string, now: string, leaseUntil: string): Promise<Effect | null> => {
    const rows = await query(`UPDATE quickbooks_write_effects AS e SET owner_id=?,owner_expires_at=?,owner_invoice_id=?,owner_invoice_version=?,
      state=CASE WHEN state='drafting' THEN 'drafting' ELSE 'prepared' END,updated_at=?
      WHERE id=? AND state IN ('drafting','prepared','sending','unknown') AND (owner_id IS NULL OR owner_expires_at<=? OR owner_id=?)
        AND ${current('e')} AND EXISTS(SELECT 1 FROM invoices i WHERE i.id=? AND i.version=? AND i.state IN ('open','paid'))
      RETURNING *`, [ownerId,leaseUntil,source.invoiceId,source.invoiceVersion,now,e.id,now,ownerId,source.invoiceId,source.invoiceVersion])
    return (rows[0] as Effect | undefined) ?? null
  }
  const owned = async (e: Effect): Promise<QuickBooksWritePlan> => ({ kind: 'owned', effectId: e.id, requestId: e.request_id,
    request: { path: e.path, minorVersion: e.minor_version, body: await readWritePayload(database, {
      direction: 'request', id: e.id, hash: e.body_hash, bytes: e.body_bytes, chunks: e.body_chunks,
    }) } })
  const unresolved = async (connection: QuickBooksWriteConnection, source: QuickBooksWriteSource): Promise<Effect | undefined> =>
    (await query(`SELECT * FROM quickbooks_write_effects WHERE generation=? AND realm_id=? AND connected_at=? AND resource=? AND native_id=?
      AND state NOT IN ('completed','cancelled') ORDER BY created_at,id LIMIT 1`,
    [connection.connectionGeneration,connection.realmId,connection.connectedAt,source.resource,source.nativeId]))[0] as Effect | undefined
  const release: ManagedQuickBooksWriteStore['releaseBeforeTransport'] = async ({ ownerId, now }) => {
    if (!uuid.test(ownerId) || !iso(now)) throw new Error('Invalid managed QuickBooks write release')
    await atomicStatements(database, [
      { text: `UPDATE quickbooks_write_attempts SET state='cancelled_unsent' WHERE id=? AND state IN ('sending','unknown') AND response_hash IS NULL RETURNING id`, params: [ownerId] },
      { text: `UPDATE quickbooks_write_effects AS e SET state=CASE WHEN EXISTS(SELECT 1 FROM quickbooks_write_attempts a
          WHERE a.effect_id=e.id AND a.state<>'cancelled_unsent') THEN 'unknown' ELSE 'cancelled' END,
          owner_id=NULL,owner_expires_at=NULL,updated_at=?
        WHERE owner_id=? AND result_attempt_id IS NULL AND state IN ('drafting','prepared','sending','unknown') RETURNING id`, params: [now,ownerId] },
    ])
  }
  return {
    prepare: async ({ connection, intent, request, effectId, ownerId, now, leaseUntil }) => {
      validate(intent, ownerId, now, leaseUntil)
      if (!validConnection(connection)) return unavailable
      if (!uuid.test(effectId) || request.path !== `/${intent.resource}` || !/^\d{1,5}$/.test(request.minorVersion)
        || !['create','update'].includes(intent.operation)) throw new Error('Invalid managed QuickBooks write request')
      const parsed: unknown = JSON.parse(request.body)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid managed QuickBooks write body')
      const payload = await encodeWritePayload(request.body)
      const descriptor = await encodeWritePayload(JSON.stringify([request.path,request.minorVersion,request.body]))
      const args = [connection.connectionGeneration,connection.realmId,connection.connectedAt,intent.resource,intent.nativeId,
        intent.operation,intent.sourceHash,descriptor.hash,request.minorVersion]
      const find = async () => (await query(`SELECT * FROM quickbooks_write_effects WHERE generation=? AND realm_id=? AND connected_at=?
        AND resource=? AND native_id=? AND operation=? AND source_hash=? AND payload_hash=? AND minor_version=? AND state<>'cancelled'`, args))[0] as Effect | undefined
      let e = await find()
      if (!e) {
        await query(`INSERT INTO quickbooks_write_effects
          (id,request_id,generation,realm_id,connected_at,actor_id,resource,native_id,invoice_id,invoice_version,operation,source_hash,
           payload_hash,body_hash,path,minor_version,body_bytes,body_chunks,state,owner_id,owner_expires_at,owner_invoice_id,owner_invoice_version,created_at,updated_at)
          SELECT ?,?,g.generation,c.realm_id,c.connected_at,c.connected_by_user_id,?,?,?,?,?,?,?,?,?,?,?,?,'drafting',?,?,?,?,?,?
          FROM quickbooks_connections c JOIN quickbooks_connection_generation g ON g.singleton=1
          WHERE c.id=1 AND c.disconnected_at IS NULL AND c.realm_id=? AND c.connected_at=? AND g.generation=?
            AND EXISTS(SELECT 1 FROM quickbooks_managed_grants m WHERE m.realm_id=c.realm_id AND m.recorded_at=c.connected_at AND m.accepted_generation=g.generation)
            AND EXISTS(SELECT 1 FROM invoices i WHERE i.id=? AND i.version=? AND i.state IN ('open','paid'))
            AND (?='invoice' AND ?=? OR ?='customer' AND EXISTS(SELECT 1 FROM clients WHERE id=?)
              OR ?='payment' AND EXISTS(SELECT 1 FROM invoice_payments WHERE id=? AND invoice_id=?))
            AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
            AND NOT EXISTS(SELECT 1 FROM quickbooks_revocations WHERE status<>'revoked')
            AND NOT EXISTS(SELECT 1 FROM quickbooks_write_effects prior WHERE prior.generation=g.generation AND prior.resource=? AND prior.native_id=?
              AND (prior.state NOT IN ('completed','cancelled') OR (?='create' AND prior.operation='create' AND prior.state='completed')))
          ON CONFLICT DO NOTHING RETURNING id`, [effectId,effectId,intent.resource,intent.nativeId,intent.invoiceId,intent.invoiceVersion,intent.operation,
          intent.sourceHash,descriptor.hash,payload.hash,request.path,request.minorVersion,payload.bytes,payload.chunks.length,
          ownerId,leaseUntil,intent.invoiceId,intent.invoiceVersion,now,now,connection.realmId,connection.connectedAt,connection.connectionGeneration,
          intent.invoiceId,intent.invoiceVersion,intent.resource,intent.nativeId,intent.invoiceId,intent.resource,intent.nativeId,
          intent.resource,intent.nativeId,intent.invoiceId,intent.resource,intent.nativeId,intent.operation])
        e = await find()
      }
      if (!e) return unavailable
      if (e.state === 'completed') return safeCompleted(e)
      if (['orphaned','conflicted'].includes(e.state)) return unavailable
      const taken = await claim(e,intent,ownerId,now,leaseUntil)
      if (!taken) return { kind: 'pending' }
      if (taken.state === 'drafting') {
        // INSERT..SELECT scopes each append to the current owner. Existing
        // immutable chunks are only reused when the complete digest matches.
        for (const chunk of payload.chunks) await query(`INSERT INTO quickbooks_write_request_chunks(effect_id,position,bytes,data)
          SELECT id,?,?,? FROM quickbooks_write_effects WHERE id=? AND owner_id=? AND state='drafting' AND owner_expires_at>?
          ON CONFLICT DO NOTHING RETURNING position`, [chunk.position,chunk.bytes,chunk.data,e.id,ownerId,now])
        await readWritePayload(database, { direction: 'request', id: e.id, hash: e.body_hash, bytes: e.body_bytes, chunks: e.body_chunks })
        const sealed = await query(`UPDATE quickbooks_write_effects SET state='prepared',updated_at=?
          WHERE id=? AND owner_id=? AND state='drafting' AND owner_expires_at>? RETURNING id`, [now,e.id,ownerId,now])
        if (!sealed.length) return unavailable
      }
      return owned(taken)
    },
    resume: async ({ connection, source, ownerId, now, leaseUntil }) => {
      validate(source,ownerId,now,leaseUntil)
      if (!validConnection(connection)) return unavailable
      const e = await unresolved(connection,source)
      if (!e) return { kind: 'none' }
      if (['orphaned','conflicted'].includes(e.state)) return unavailable
      if (e.owner_id && e.owner_expires_at! > now) return { kind: 'pending' }
      const transported = (await query("SELECT id FROM quickbooks_write_attempts WHERE effect_id=? AND state<>'cancelled_unsent' LIMIT 1", [e.id])).length > 0
      if (transported && e.source_hash !== source.sourceHash) return unavailable
      const taken = await claim(e,source,ownerId,now,leaseUntil)
      if (!taken) return unavailable
      if (!transported && (e.source_hash !== source.sourceHash || taken.state === 'drafting')) {
        await release({ ownerId,now }); return { kind: 'none' }
      }
      return owned(taken)
    },
    begin: async ({ effectId, ownerId, now }) => {
      if (!uuid.test(effectId) || !uuid.test(ownerId) || !iso(now)) throw new Error('Invalid managed QuickBooks write begin')
      const result = await atomicStatements(database, [
        { text: `UPDATE quickbooks_write_effects AS e SET state='sending',updated_at=? WHERE id=? AND owner_id=? AND owner_expires_at>?
          AND state='prepared' AND ${current('e')} AND ${invoiceCurrent('e')}
          AND NOT EXISTS(SELECT 1 FROM quickbooks_refresh_attempts WHERE status NOT IN ('completed','cancelled'))
          AND NOT EXISTS(SELECT 1 FROM quickbooks_write_attempts WHERE id=?) RETURNING id`, params: [now,effectId,ownerId,now,ownerId] },
        { text: `INSERT INTO quickbooks_write_attempts(id,effect_id,state,started_at)
          SELECT ?,id,'sending',? FROM quickbooks_write_effects WHERE id=? AND state='sending' AND owner_id=?
          ON CONFLICT DO NOTHING RETURNING id`, params: [ownerId,now,effectId,ownerId] },
      ])
      return result[0]?.[0]?.id === effectId && result[1]?.[0]?.id === ownerId
    },
    releaseBeforeTransport: release,
    unknown: async ({ effectId, ownerId, now }) => {
      if (!uuid.test(effectId) || !uuid.test(ownerId) || !iso(now)) throw new Error('Invalid managed QuickBooks write outcome')
      await atomicStatements(database, [
        { text: `UPDATE quickbooks_write_attempts SET state='unknown' WHERE id=? AND effect_id=? AND state='sending' AND response_hash IS NULL RETURNING id`, params: [ownerId,effectId] },
        { text: `UPDATE quickbooks_write_effects SET state='unknown',owner_id=NULL,owner_expires_at=NULL,updated_at=?
          WHERE id=? AND owner_id=? AND state='sending' AND result_attempt_id IS NULL RETURNING id`, params: [now,effectId,ownerId] },
      ])
    },
    complete: async ({ effectId, ownerId, response: body, now }) => {
      if (!uuid.test(effectId) || !uuid.test(ownerId) || !iso(now)) throw new Error('Invalid managed QuickBooks write completion')
      const e = await effect(effectId)
      if (!e) return null
      const document = JSON.parse(body) as Record<string, unknown>
      const key = { customer: 'Customer', invoice: 'Invoice', payment: 'Payment' }[e.resource]
      const entity = key ? document[key] as Record<string, unknown> | undefined : undefined
      if (!entity || typeof entity.Id !== 'string' || !entity.Id || typeof entity.SyncToken !== 'string' || !entity.SyncToken) return null
      const payload = await encodeWritePayload(body)
      await query(`UPDATE quickbooks_write_attempts SET response_hash=?,response_bytes=?,response_chunks=?,provider_id=?,sync_token=?
        WHERE id=? AND effect_id=? AND state IN ('sending','unknown') AND response_hash IS NULL RETURNING id`,
      [payload.hash,payload.bytes,payload.chunks.length,entity.Id,entity.SyncToken,ownerId,effectId])
      const a = (await query('SELECT * FROM quickbooks_write_attempts WHERE id=? AND effect_id=? AND response_hash=?', [ownerId,effectId,payload.hash]))[0]
      if (!a || a.state === 'cancelled_unsent') return null
      if (a.state !== 'observed') {
        for (const chunk of payload.chunks) await query(`INSERT INTO quickbooks_write_response_chunks(attempt_id,position,bytes,data)
          SELECT id,?,?,? FROM quickbooks_write_attempts WHERE id=? AND state IN ('sending','unknown') AND response_hash=?
          ON CONFLICT DO NOTHING RETURNING position`, [chunk.position,chunk.bytes,chunk.data,ownerId,payload.hash])
        await readWritePayload(database, { direction: 'response', id: ownerId, hash: payload.hash, bytes: payload.bytes, chunks: payload.chunks.length })
        await query(`UPDATE quickbooks_write_attempts SET state='observed',observed_at=? WHERE id=? AND state IN ('sending','unknown') AND response_hash=? RETURNING id`, [now,ownerId,payload.hash])
      }
      await atomicStatements(database, [
        { text: `UPDATE quickbooks_write_effects AS e SET result_attempt_id=?,state=CASE WHEN ${current('e')} THEN 'completed' ELSE 'orphaned' END,
          owner_id=NULL,owner_expires_at=NULL,updated_at=? WHERE id=? AND result_attempt_id IS NULL
          AND EXISTS(SELECT 1 FROM quickbooks_write_attempts a WHERE a.id=? AND a.effect_id=e.id AND a.state='observed') RETURNING id`, params: [ownerId,now,effectId,ownerId] },
        { text: `UPDATE quickbooks_write_effects AS e SET state='conflicted',owner_id=NULL,owner_expires_at=NULL,updated_at=? WHERE id=?
          AND EXISTS(SELECT 1 FROM quickbooks_write_attempts chosen JOIN quickbooks_write_attempts other ON other.effect_id=chosen.effect_id
            WHERE chosen.id=e.result_attempt_id AND other.state='observed' AND (other.provider_id<>chosen.provider_id OR other.sync_token<>chosen.sync_token)) RETURNING id`, params: [now,effectId] },
      ])
      const final = await effect(effectId)
      if (!final) return null
      const plan = await safeCompleted(final)
      return plan.kind === 'completed' ? plan.response : null
    },
    knownCreatedLink: async ({ connection, resource, nativeId }) => {
      if (!validConnection(connection) || !positive(nativeId)) return null
      const rows = await query(`SELECT a.provider_id,a.sync_token FROM quickbooks_write_effects e
        JOIN quickbooks_write_attempts a ON a.id=e.result_attempt_id AND a.state='observed'
        WHERE e.generation=? AND e.realm_id=? AND e.connected_at=? AND e.resource=? AND e.native_id=? AND e.operation='create'
          AND e.state='completed' AND ${current('e')} ORDER BY e.created_at,e.id LIMIT 1`,
      [connection.connectionGeneration,connection.realmId,connection.connectedAt,resource,nativeId])
      return rows[0] ? { quickBooksId: rows[0].provider_id as string, syncToken: rows[0].sync_token as string } : null
    },
    pendingWrites: async ({ connection, limit, now }) => {
      if (!validConnection(connection) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !iso(now)) return []
      const rows = await query(`UPDATE quickbooks_write_effects SET recovery_checked_at=? WHERE id IN (
        SELECT e.id FROM quickbooks_write_effects e WHERE generation=? AND realm_id=? AND connected_at=?
          AND state IN ('drafting','prepared','sending','unknown') AND (owner_id IS NULL OR owner_expires_at<=?) AND ${current('e')}
          ORDER BY COALESCE(recovery_checked_at,created_at),id LIMIT ?)
        RETURNING resource,native_id,owner_invoice_id`, [now,connection.connectionGeneration,connection.realmId,connection.connectedAt,now,limit])
      return rows.map(row => ({ resource: row.resource as 'customer' | 'invoice' | 'payment', nativeId: row.native_id as number, invoiceId: row.owner_invoice_id as number }))
    },
    status: async () => {
      const rows = await query(`SELECT CASE WHEN EXISTS(SELECT 1 FROM quickbooks_write_effects WHERE state IN ('orphaned','conflicted')) THEN 'unavailable'
        WHEN EXISTS(SELECT 1 FROM quickbooks_write_effects WHERE state NOT IN ('completed','cancelled')) THEN 'pending' ELSE 'ready' END AS state`)
      return rows[0]?.state as 'ready' | 'pending' | 'unavailable'
    },
  }
}
