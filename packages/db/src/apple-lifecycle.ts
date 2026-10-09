import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { AppleLifecycleStore, AppleGrantBinding } from '@ezacto/core'
import { accountClosureDigest, closedAccountProviderKey } from './account-closure-sign-in.js'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
const canonicalTime = (value: string) => {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new RangeError('Invalid Apple lifecycle time')
  return Date.parse(value)
}
const validBinding = (input: AppleGrantBinding) => {
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !input.subject ||
    !input.grantId ||
    !input.eventId
  )
    throw new RangeError('Invalid Apple grant binding')
}
const uniqueConflict = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed/.test(error.message)

export function createAppleLifecycleRepository(database: Database): AppleLifecycleStore {
  const subjectHash = async (subject: string) => {
    const rows = await database.all<{ secret: string }>(
      sql`SELECT secret FROM account_closure_security WHERE id=1`,
    )
    return accountClosureDigest(
      rows[0]!.secret,
      'provider',
      closedAccountProviderKey('apple', subject),
    )
  }
  const captureCurrent = async (requestId: string) => {
    const identities = await database.all<{
      provider_subject: string
    }>(sql`SELECT identity.provider_subject FROM user_identities identity
      JOIN account_deletion_requests request ON request.user_id=identity.user_id
      WHERE request.id=${requestId} AND request.status<>'completed' AND identity.provider='apple'`)
    for (const identity of identities) {
      const digest = await subjectHash(identity.provider_subject)
      await database.run(sql`INSERT INTO apple_deletion_subjects(request_id,subject_hash,origin,grant_id,generation,updated_at)
        SELECT request.id,${digest},grant_record.origin,grant_record.grant_id,grant_record.generation,request.updated_at
        FROM account_deletion_requests request LEFT JOIN apple_native_grants grant_record ON grant_record.subject_hash=${digest}
        WHERE request.id=${requestId} AND request.status<>'completed' AND EXISTS(
          SELECT 1 FROM user_identities WHERE user_id=request.user_id AND provider='apple' AND provider_subject=${identity.provider_subject})
        ON CONFLICT(request_id,subject_hash) DO NOTHING`)
    }
  }
  const store: AppleLifecycleStore = {
    async begin(userId, requestId) {
      if (
        !(
          await database.all(
            sql`SELECT 1 FROM account_deletion_requests WHERE id=${requestId} AND user_id=${userId}`,
          )
        ).length
      )
        throw new Error('Deletion request not found')
      await captureCurrent(requestId)
    },
    async recordSignIn(input) {
      validBinding(input)
      canonicalTime(input.now)
      const digest = await subjectHash(input.subject)
      try {
        const rows =
          await database.all(sql`INSERT INTO apple_native_grants(subject_hash,user_id,origin,grant_id,generation,binding_jti,updated_at)
          SELECT ${digest},${input.userId},${input.origin},${input.grantId},${input.generation},${input.eventId},${input.now}
          WHERE EXISTS(SELECT 1 FROM users WHERE id=${input.userId} AND is_active=1)
            AND EXISTS(SELECT 1 FROM user_identities WHERE user_id=${input.userId} AND provider='apple' AND provider_subject=${input.subject})
            AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=${input.userId})
          ON CONFLICT(subject_hash) DO UPDATE SET origin=excluded.origin,grant_id=excluded.grant_id,generation=excluded.generation,binding_jti=excluded.binding_jti,updated_at=excluded.updated_at
          WHERE apple_native_grants.user_id=excluded.user_id AND excluded.generation>apple_native_grants.generation
          RETURNING subject_hash`)
        return rows.length === 1
      } catch (error) {
        if (uniqueConflict(error)) return false
        throw error
      }
    },
    async rebind(input) {
      validBinding(input)
      canonicalTime(input.now)
      const digest = await subjectHash(input.subject)
      const matching = async () =>
        (
          await database.all(sql`SELECT 1 FROM apple_deletion_subjects subject JOIN account_deletion_requests request ON request.id=subject.request_id
        WHERE subject.request_id=${input.requestId} AND subject.subject_hash=${digest} AND subject.origin=${input.origin}
          AND subject.grant_id=${input.grantId} AND subject.generation=${input.generation} AND request.status<>'completed'`)
        ).length === 1
      if (await matching()) return true
      await database.run(sql`INSERT INTO apple_deletion_subjects(request_id,subject_hash,origin,grant_id,generation,updated_at)
        SELECT request.id,${digest},${input.origin},${input.grantId},${input.generation},${input.now} FROM account_deletion_requests request
        WHERE request.id=${input.requestId} AND request.status<>'completed'
          AND ${input.generation}>COALESCE((SELECT generation FROM apple_native_grants WHERE subject_hash=${digest}),0)
          AND (EXISTS(SELECT 1 FROM apple_deletion_subjects WHERE request_id=request.id AND subject_hash=${digest})
            OR EXISTS(SELECT 1 FROM user_identities WHERE user_id=request.user_id AND provider='apple' AND provider_subject=${input.subject})
            OR EXISTS(SELECT 1 FROM closed_account_sign_in_guards WHERE request_id=request.id AND kind='provider' AND digest=${digest}))
        ON CONFLICT(request_id,subject_hash) DO UPDATE SET origin=excluded.origin,grant_id=excluded.grant_id,generation=excluded.generation,updated_at=excluded.updated_at
        WHERE apple_deletion_subjects.generation IS NULL OR excluded.generation>apple_deletion_subjects.generation`)
      return matching()
    },
    async acceptRevocation(input) {
      validBinding(input)
      canonicalTime(input.now)
      canonicalTime(input.revokedAt)
      const digest = await subjectHash(input.subject)
      const matching = async () =>
        (
          await database.all(sql`SELECT 1 FROM apple_revocation_events event JOIN apple_deletion_subjects subject
        ON subject.request_id=event.request_id AND subject.subject_hash=event.subject_hash
        WHERE event.request_id=${input.requestId} AND event.subject_hash=${digest} AND event.origin=${input.origin}
          AND event.grant_id=${input.grantId} AND event.generation=${input.generation} AND event.event_id=${input.eventId} AND event.revoked_at=${input.revokedAt}
          AND subject.origin=event.origin AND subject.grant_id=event.grant_id AND subject.generation=event.generation`)
        ).length === 1
      if (await matching()) return true
      try {
        await database.run(sql`INSERT INTO apple_revocation_events(request_id,subject_hash,origin,grant_id,generation,event_id,revoked_at,accepted_at)
          SELECT subject.request_id,subject.subject_hash,subject.origin,subject.grant_id,subject.generation,${input.eventId},${input.revokedAt},${input.now}
          FROM apple_deletion_subjects subject JOIN account_deletion_requests request ON request.id=subject.request_id
          WHERE subject.request_id=${input.requestId} AND subject.subject_hash=${digest} AND subject.origin=${input.origin}
            AND subject.grant_id=${input.grantId} AND subject.generation=${input.generation} AND request.status<>'completed'
          ON CONFLICT DO NOTHING`)
      } catch (error) {
        if (uniqueConflict(error)) return false
        throw error
      }
      return matching()
    },
    async status(requestId) {
      // Status is read-only. Older requests without a captured obligation stay
      // conservative until an explicit request/closure capture occurs.
      const current = await database.all<{
        provider_subject: string
      }>(sql`SELECT identity.provider_subject FROM user_identities identity
        JOIN account_deletion_requests request ON request.user_id=identity.user_id
        WHERE request.id=${requestId} AND request.status<>'completed' AND identity.provider='apple'`)
      for (const identity of current) {
        const digest = await subjectHash(identity.provider_subject)
        if (
          !(
            await database.all(
              sql`SELECT 1 FROM apple_deletion_subjects WHERE request_id=${requestId} AND subject_hash=${digest}`,
            )
          ).length
        )
          return 'manual_required'
      }
      if (
        (
          await database.all(
            sql`SELECT 1 FROM apple_deletion_unknown WHERE request_id=${requestId}`,
          )
        ).length
      )
        return 'manual_required'
      const rows = await database.all<{
        generation: number | null
        revoked: number
      }>(sql`SELECT subject.generation,EXISTS(SELECT 1 FROM apple_revocation_events event
        WHERE event.request_id=subject.request_id AND event.subject_hash=subject.subject_hash AND event.origin=subject.origin
          AND event.grant_id=subject.grant_id AND event.generation=subject.generation) AS revoked
        FROM apple_deletion_subjects subject WHERE subject.request_id=${requestId}`)
      if (rows.length === 0) return 'not_linked'
      if (rows.some((row) => row.generation === null)) return 'manual_required'
      return rows.every((row) => row.revoked === 1) ? 'revoked' : 'pending'
    },
    async allowProof(now) {
      const minute = Math.floor(canonicalTime(now) / 60000)
      const rows = await database.all<{
        attempts: number
      }>(sql`INSERT INTO apple_lifecycle_limits(window_minute,attempts) VALUES(${minute},1)
        ON CONFLICT(window_minute) DO UPDATE SET attempts=min(attempts+1,121) RETURNING attempts`)
      await database.run(sql`DELETE FROM apple_lifecycle_limits WHERE window_minute<${minute - 2}`)
      return rows[0]!.attempts <= 120
    },
  }
  // Drizzle errors can contain bound provider subjects. Drop those causes at
  // this boundary before the runtime's ordinary error reporter sees them.
  const protect =
    <Arguments extends unknown[], Result>(method: (...args: Arguments) => Promise<Result>) =>
    async (...args: Arguments): Promise<Result> => {
      try {
        return await method(...args)
      } catch {
        throw new Error('Apple lifecycle persistence is temporarily unavailable')
      }
    }
  return {
    begin: protect(store.begin),
    recordSignIn: protect(store.recordSignIn),
    rebind: protect(store.rebind),
    acceptRevocation: protect(store.acceptRevocation),
    status: protect(store.status),
    allowProof: protect(store.allowProof),
  }
}
