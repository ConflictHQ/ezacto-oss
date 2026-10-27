import {
  CalendarConnectionError,
  calendarEventKey,
  calendarProposalTitle,
  type CalendarConnectionAuthority,
  type CalendarConnectionStore,
  type CalendarPrivateConnection,
  type CalendarProvider,
  type CalendarSyncLease,
} from '@ezacto/core'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import type { TrackedResourceDatabase } from './tracked-resource-repository.js'

interface Row {
  user_id: number
  provider: CalendarProvider
  instance_nonce: string
  generation: number
  credential_revision: number
  status: CalendarPrivateConnection['state']
  key_id: string | null
  sealed_grant: string | null
  sealed_cursor: string | null
  window_from: string | null
  window_to: string | null
  lease_generation: number
  lease_holder: string | null
  last_synced_at: string | null
  last_error:
    | 'credential_unavailable'
    | 'authorization'
    | 'unavailable'
    | 'invalid_source'
    | 'limit'
    | 'changed'
    | null
  lease_expires_at: string | null
}
const currentUser = `EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1 AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=users.id))
  AND NOT EXISTS(SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1)
  AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))`
const session = `${currentUser} AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND julianday(s.idle_expires_at)>julianday(?)
  AND julianday(s.absolute_expires_at)>julianday(?) AND s.profile_snapshot=u.profile AND s.manager_grants_snapshot=u.manager_grants)`
const authorityValues = (a: CalendarConnectionAuthority, now: string) => [
  a.userId,
  a.sessionId,
  a.userId,
  now,
  now,
]
const privateRow = (row: Row): CalendarPrivateConnection => ({
  userId: row.user_id,
  provider: row.provider,
  instance: row.instance_nonce,
  generation: row.generation,
  credentialRevision: row.credential_revision,
  state: row.status,
  keyId: row.key_id,
  sealedGrant: row.sealed_grant,
  sealedCursor: row.sealed_cursor,
  window: row.window_from && row.window_to ? { from: row.window_from, to: row.window_to } : null,
})
const fail = (code: ConstructorParameters<typeof CalendarConnectionError>[0]): never => {
  throw new CalendarConnectionError(code)
}
export const createCalendarConnectionStore = (
  database: TrackedResourceDatabase,
): CalendarConnectionStore => {
  const atomic = (statements: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(
      database as InvoiceStateDatabase,
      statements.map((statement) => ({
        ...statement,
        text:
          /^\s*(INSERT|UPDATE|DELETE)\b/i.test(statement.text) &&
          !/\bRETURNING\b/i.test(statement.text)
            ? statement.text + ' RETURNING 1'
            : statement.text,
      })),
    )
  const query = async <T>(text: string, params: readonly unknown[] = []) =>
    (await atomic([{ text, params }]))[0] as T[]
  const readRow = async (user: number, provider: CalendarProvider) =>
    (
      await query<Row>('SELECT * FROM calendar_connections WHERE user_id=? AND provider=?', [
        user,
        provider,
      ])
    )[0] ?? null
  const guard = (sql: string, params: readonly unknown[]) => ({
    text: `INSERT INTO calendar_sync_guard(allowed) SELECT CASE WHEN ${sql} THEN 1 ELSE 0 END`,
    params,
  })
  const clear = { text: 'DELETE FROM calendar_sync_guard', params: [] }
  const leaseGuard = (lease: CalendarSyncLease, now: string) =>
    guard(
      `EXISTS(SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=?
    AND generation=? AND credential_revision=? AND instance_nonce=? AND instance_nonce=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
    AND status='connected' AND lease_generation=? AND lease_holder=? AND julianday(lease_expires_at)>julianday(?)) AND (${currentUser})`,
      [
        lease.userId,
        lease.provider,
        lease.generation,
        lease.credentialRevision,
        lease.instance,
        lease.leaseGeneration,
        lease.holder,
        now,
        lease.userId,
      ],
    )
  const cleanup = (
    user: number,
    provider: CalendarProvider,
    reason: 'disconnect' | 'reauth',
    now: string,
    manual = false,
  ) => ({
    text: `INSERT OR IGNORE INTO calendar_cleanup_obligations(id,user_id,provider,instance_nonce,generation,credential_revision,key_id,sealed_grant,reason,status,created_at)
      SELECT lower(hex(randomblob(32))),user_id,provider,instance_nonce,generation,credential_revision,key_id,sealed_grant,?,?,?
      FROM calendar_connections WHERE user_id=? AND provider=? AND sealed_grant IS NOT NULL`,
    params: [reason, manual ? 'manual_required' : 'pending', now, user, provider],
  })
  const leaseIdentity = (lease: CalendarSyncLease) => [
    lease.userId,
    lease.provider,
    lease.generation,
    lease.credentialRevision,
    lease.leaseGeneration,
    lease.holder,
  ]
  return {
    async cleanupStatus(authority, now) {
      const rows = await query<{ pending: number; manual_required: number; revoked: number }>(
        `SELECT
        (SELECT count(*) FROM calendar_cleanup_obligations WHERE status='pending') AS pending,
        (SELECT count(*) FROM calendar_cleanup_obligations WHERE status='manual_required') AS manual_required,
        (SELECT count(*) FROM calendar_cleanup_obligations WHERE status='revoked') AS revoked
        WHERE (${session}) AND EXISTS(SELECT 1 FROM users WHERE id=? AND profile='administrator')`,
        [...authorityValues(authority, now), authority.userId],
      )
      return rows[0] ?? fail('forbidden')
    },
    async instance() {
      return (
        (
          await query<{ nonce: string }>(
            'SELECT nonce FROM calendar_sync_instance WHERE singleton=1',
          )
        )[0]?.nonce ?? fail('unavailable')
      )
    },
    async authorize(authority, now) {
      if (
        !Number.isSafeInteger(authority.userId) ||
        authority.userId < 1 ||
        !Number.isSafeInteger(authority.sessionId) ||
        authority.sessionId < 1
      )
        fail('forbidden')
      if (!(await query(`SELECT 1 WHERE ${session}`, authorityValues(authority, now))).length)
        fail('forbidden')
    },
    async list(authority, now) {
      await this.authorize(authority, now)
      const instance = await this.instance()
      const pending = new Set(
        (
          await query<{ provider: CalendarProvider }>(
            "SELECT provider FROM calendar_cleanup_obligations WHERE user_id=? AND instance_nonce=coalesce((SELECT c.instance_nonce FROM calendar_connections c WHERE c.user_id=calendar_cleanup_obligations.user_id AND c.provider=calendar_cleanup_obligations.provider),(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)) AND status<>'revoked'",
            [authority.userId],
          )
        ).map((row) => row.provider),
      )
      return (
        await query<Row>('SELECT * FROM calendar_connections WHERE user_id=?', [authority.userId])
      ).map((row) => ({
        provider: row.provider,
        state: row.instance_nonce === instance ? row.status : ('needs_reauth' as const),
        generation: row.generation,
        lastSyncedAt: row.last_synced_at,
        lastError: row.last_error,
        cleanupPending: pending.has(row.provider),
        syncing: !!row.lease_holder && Date.parse(row.lease_expires_at ?? '') > Date.parse(now),
      }))
    },
    async read(userId, provider) {
      const row = await readRow(userId, provider)
      return row ? privateRow(row) : null
    },
    async connect(authority, provider, expectedGeneration, credential, now) {
      await this.authorize(authority, now)
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) fail('invalid')
      const row = await readRow(authority.userId, provider)
      if ((row?.generation ?? 0) !== expectedGeneration) fail('changed')
      if (
        row?.status === 'connected' ||
        (
          await query(
            "SELECT 1 FROM calendar_cleanup_obligations WHERE user_id=? AND provider=? AND instance_nonce=coalesce((SELECT c.instance_nonce FROM calendar_connections c WHERE c.user_id=calendar_cleanup_obligations.user_id AND c.provider=calendar_cleanup_obligations.provider),(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)) AND status<>'revoked' LIMIT 1",
            [authority.userId, provider],
          )
        ).length
      )
        fail('busy')
      try {
        await atomic([
          guard(
            `(${session}) AND ?=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
          AND coalesce((SELECT generation FROM calendar_connections WHERE user_id=? AND provider=?),0)=?
          AND NOT EXISTS(SELECT 1 FROM calendar_cleanup_obligations WHERE user_id=? AND provider=? AND instance_nonce=coalesce((SELECT c.instance_nonce FROM calendar_connections c WHERE c.user_id=calendar_cleanup_obligations.user_id AND c.provider=calendar_cleanup_obligations.provider),(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)) AND status<>'revoked')`,
            [
              ...authorityValues(authority, now),
              credential.instance,
              authority.userId,
              provider,
              expectedGeneration,
              authority.userId,
              provider,
            ],
          ),
          {
            text: `INSERT INTO calendar_connections(user_id,provider,instance_nonce,generation,credential_revision,status,key_id,sealed_grant,updated_at)
          VALUES(?,?,?,?,1,'connected',?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET instance_nonce=excluded.instance_nonce,
          generation=excluded.generation,credential_revision=1,status='connected',key_id=excluded.key_id,sealed_grant=excluded.sealed_grant,
          sealed_cursor=NULL,window_from=NULL,window_to=NULL,last_synced_at=NULL,last_error=NULL,lease_generation=calendar_connections.lease_generation+1,
          lease_holder=NULL,lease_expires_at=NULL,updated_at=excluded.updated_at`,
            params: [
              authority.userId,
              provider,
              credential.instance,
              expectedGeneration + 1,
              credential.keyId,
              credential.sealedGrant,
              now,
            ],
          },
          clear,
        ])
      } catch {
        await this.authorize(authority, now)
        fail('changed')
      }
    },
    async disconnect(authority, provider, expectedGeneration, now, manualCleanup = false) {
      await this.authorize(authority, now)
      try {
        await atomic([
          guard(
            `(${session}) AND EXISTS(SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND generation=?)`,
            [...authorityValues(authority, now), authority.userId, provider, expectedGeneration],
          ),
          cleanup(authority.userId, provider, 'disconnect', now, manualCleanup),
          {
            text: `UPDATE calendar_connections SET generation=generation+1,credential_revision=1,status='disconnected',key_id=NULL,sealed_grant=NULL,sealed_cursor=NULL,
          window_from=NULL,window_to=NULL,lease_generation=lease_generation+1,lease_holder=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE user_id=? AND provider=?`,
            params: [now, authority.userId, provider],
          },
          {
            text: "UPDATE calendar_proposals SET status='cancelled',updated_at=? WHERE user_id=? AND provider=? AND status='proposed'",
            params: [now, authority.userId, provider],
          },
          clear,
        ])
      } catch {
        await this.authorize(authority, now)
        fail('changed')
      }
    },
    async snapshots(user, provider, window) {
      const rows = await query<{
        calendar_id: string
        event_id: string
        occurrence: string
        status: 'proposed' | 'accepted' | 'discarded' | 'cancelled'
        source_version: string | null
        observed_source_version: string | null
      }>(
        `SELECT calendar_id,event_id,occurrence,status,source_version,observed_source_version FROM calendar_proposals WHERE user_id=? AND provider=? AND starts_at>=? AND starts_at<? LIMIT 5001`,
        [user, provider, window.from, window.to],
      )
      if (rows.length > 5000) fail('unavailable')
      return new Map(
        rows.map((row) => [
          calendarEventKey({
            calendarId: row.calendar_id,
            eventId: row.event_id,
            occurrence: row.occurrence,
          }),
          { status: row.status, version: row.observed_source_version ?? row.source_version },
        ]),
      )
    },
    async claim(connection, holder, now, expiresAt) {
      const rows = await query<Row>(
        `UPDATE calendar_connections SET lease_generation=lease_generation+1,lease_holder=?,lease_expires_at=?,updated_at=?
        WHERE user_id=? AND provider=? AND generation=? AND credential_revision=? AND instance_nonce=? AND instance_nonce=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
        AND status='connected' AND (lease_holder IS NULL OR julianday(lease_expires_at)<=julianday(?)) AND (${currentUser}) RETURNING *`,
        [
          holder,
          expiresAt,
          now,
          connection.userId,
          connection.provider,
          connection.generation,
          connection.credentialRevision,
          connection.instance,
          now,
          connection.userId,
        ],
      )
      const row = rows[0]
      return row ? { ...privateRow(row), holder, leaseGeneration: row.lease_generation } : null
    },
    async rotate(lease, credential, now) {
      try {
        const rows = await atomic([
          leaseGuard(lease, now),
          {
            text: `UPDATE calendar_connections SET credential_revision=credential_revision+1,key_id=?,sealed_grant=?,sealed_cursor=?,updated_at=?
        WHERE user_id=? AND provider=? RETURNING *`,
            params: [
              credential.keyId,
              credential.sealedGrant,
              credential.sealedCursor,
              now,
              lease.userId,
              lease.provider,
            ],
          },
          clear,
        ])
        return {
          ...privateRow(rows[1]![0] as unknown as Row),
          holder: lease.holder,
          leaseGeneration: lease.leaseGeneration,
        }
      } catch {
        return fail('changed')
      }
    },
    async commit(lease, input, now) {
      const writes: Parameters<typeof atomicStatements>[1][number][] = [leaseGuard(lease, now)]
      for (const action of input.actions) {
        const e = action.event,
          identity = [lease.userId, lease.provider, e.calendarId, e.eventId, e.occurrence]
        if (action.kind === 'propose' || action.kind === 'update') {
          writes.push({
            text: `INSERT INTO calendar_proposals(user_id,provider,calendar_id,event_id,occurrence,title,starts_at,ends_at,status,source_version,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'proposed',?,?,?) ON CONFLICT(user_id,provider,calendar_id,event_id,occurrence) DO UPDATE SET
            title=CASE WHEN calendar_proposals.status='proposed' THEN excluded.title ELSE calendar_proposals.title END,
            starts_at=CASE WHEN calendar_proposals.status='proposed' THEN excluded.starts_at ELSE calendar_proposals.starts_at END,
            ends_at=CASE WHEN calendar_proposals.status='proposed' THEN excluded.ends_at ELSE calendar_proposals.ends_at END,
            source_version=CASE WHEN calendar_proposals.status='proposed' THEN excluded.source_version ELSE calendar_proposals.source_version END,
            observed_source_version=CASE WHEN calendar_proposals.status='accepted' THEN excluded.source_version ELSE calendar_proposals.observed_source_version END,
            source_changed_at=CASE WHEN calendar_proposals.status='accepted' AND coalesce(calendar_proposals.observed_source_version,calendar_proposals.source_version) IS NOT excluded.source_version THEN excluded.updated_at ELSE calendar_proposals.source_changed_at END,
            updated_at=excluded.updated_at WHERE calendar_proposals.status IN('proposed','accepted')`,
            params: [
              ...identity,
              calendarProposalTitle(e.summary),
              new Date(e.startsAt).toISOString(),
              new Date(e.endsAt).toISOString(),
              e.version,
              now,
              now,
            ],
          })
        } else if (action.kind === 'cancel') {
          writes.push({
            text: `UPDATE calendar_proposals SET status=CASE WHEN status='proposed' THEN 'cancelled' ELSE status END,
            observed_source_version=?,source_cancelled_at=?,source_changed_at=CASE WHEN status='accepted' THEN ? ELSE source_changed_at END,updated_at=?
            WHERE user_id=? AND provider=? AND calendar_id=? AND event_id=? AND occurrence=? AND status IN('proposed','accepted')`,
            params: [e.version, now, now, now, ...identity],
          })
        } else {
          writes.push({
            text: `UPDATE calendar_proposals SET observed_source_version=?,source_changed_at=?,source_cancelled_at=CASE WHEN ? THEN ? ELSE source_cancelled_at END,updated_at=?
            WHERE user_id=? AND provider=? AND calendar_id=? AND event_id=? AND occurrence=? AND status='accepted'`,
            params: [e.version, now, e.cancelled ? 1 : 0, now, now, ...identity],
          })
        }
      }
      writes.push(
        {
          text: `UPDATE calendar_connections SET sealed_cursor=?,window_from=?,window_to=?,last_synced_at=?,last_error=NULL,
        lease_holder=NULL,lease_expires_at=NULL,updated_at=? WHERE user_id=? AND provider=? AND generation=? AND credential_revision=? AND lease_generation=? AND lease_holder=?`,
          params: [
            input.sealedCursor,
            input.window.from,
            input.window.to,
            now,
            now,
            ...leaseIdentity(lease),
          ],
        },
        clear,
      )
      try {
        await atomic(writes)
      } catch {
        fail('changed')
      }
    },
    async fail(lease, failure, now) {
      const reauth = failure === 'authorization' || failure === 'credential_unavailable'
      try {
        await atomic([
          leaseGuard(lease, now),
          ...(reauth
            ? [
                cleanup(
                  lease.userId,
                  lease.provider,
                  'reauth',
                  now,
                  failure === 'credential_unavailable',
                ),
              ]
            : []),
          {
            text: `UPDATE calendar_connections SET last_error=?,lease_holder=NULL,lease_expires_at=NULL,updated_at=?,
        status=CASE WHEN ? THEN 'needs_reauth' ELSE status END,generation=generation+?,credential_revision=CASE WHEN ? THEN 1 ELSE credential_revision END,
        sealed_grant=CASE WHEN ? THEN NULL ELSE sealed_grant END,key_id=CASE WHEN ? THEN NULL ELSE key_id END
        WHERE user_id=? AND provider=?`,
            params: [
              failure,
              now,
              reauth ? 1 : 0,
              reauth ? 1 : 0,
              reauth ? 1 : 0,
              reauth ? 1 : 0,
              reauth ? 1 : 0,
              lease.userId,
              lease.provider,
            ],
          },
          clear,
        ])
      } catch {
        fail('changed')
      }
    },
  }
}
