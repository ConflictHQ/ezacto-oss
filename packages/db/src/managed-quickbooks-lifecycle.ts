import {
  ManagedQuickBooksGrantError,
  type ManagedQuickBooksAuthority,
  type ManagedQuickBooksFenceCommand,
  type ManagedQuickBooksLifecycleStore,
  type ManagedQuickBooksRevocationReceipt,
} from '@ezacto/core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { fail, hex, validAuthority, validTime } from './managed-quickbooks.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type Row = {
  revocation_id: string
  grant_id: string
  actor_id: number
  realm_id: string
  environment: 'sandbox' | 'production'
  reason: 'disconnect' | 'suspension' | 'erasure'
  expected_generation: number
  fenced_generation: number
  status: 'pending' | 'attempting' | 'revoked'
  attempts: number
}
const columns = `revocation_id,grant_id,actor_id,realm_id,environment,reason,expected_generation,fenced_generation,status,attempts`
const receipt = (row: Row): ManagedQuickBooksRevocationReceipt => ({
  revocationId: row.revocation_id,
  grantId: row.grant_id,
  actorUserId: row.actor_id,
  realmId: row.realm_id,
  environment: row.environment,
  reason: row.reason,
  fencedGeneration: row.fenced_generation,
  status: row.status,
  attempts: row.attempts,
  complete: row.status === 'revoked',
})
const placeholderTime = '1970-01-01T00:00:00Z'

/** Lifecycle fence and revocation custody. The provider is never called here:
 * the host revokes outside any replayable transaction and reports the result.
 * The credential is returned once, to the trusted process, never in a receipt. */
export const createManagedQuickBooksLifecycleStore = (
  database: Database,
): ManagedQuickBooksLifecycleStore => {
  const atomic = (statements: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(database as InvoiceStateDatabase, statements)
  const read = async (revocationId: string) =>
    (
      await atomic([
        {
          text: `SELECT ${columns} FROM quickbooks_revocations WHERE revocation_id=?`,
          params: [revocationId],
        },
      ])
    )[0]?.[0] as Row | undefined
  const facts = async (authority: ManagedQuickBooksAuthority, now: string, grantId: string) => {
    const result = await atomic([
      {
        text: `SELECT g.generation,
          (EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile='administrator') AND
            (?=1 OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL
              AND julianday(idle_expires_at)>julianday(?) AND julianday(absolute_expires_at)>julianday(?) AND profile_snapshot='administrator'))) AS authorized,
          EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL)) AS blocked,
          (SELECT accepted_generation FROM quickbooks_managed_grants WHERE grant_id=?) AS grant_generation,
          EXISTS(SELECT 1 FROM quickbooks_connections WHERE id=1 AND disconnected_at IS NULL) AS live
          FROM quickbooks_connection_generation g WHERE g.singleton=1`,
        params: [
          authority.userId,
          authority.kind === 'guarded-session' ? 1 : 0,
          authority.kind === 'native-session' ? authority.sessionId : 0,
          authority.userId,
          now,
          now,
          grantId,
        ],
      },
    ])
    const row = result[0]?.[0] as
      | {
          generation: number
          authorized: number
          blocked: number
          grant_generation: number | null
          live: number
        }
      | undefined
    if (!row || row.blocked) fail('conflict')
    if (!row!.authorized) fail('forbidden')
    return row!
  }
  const required = async (revocationId: string) => {
    if (!hex(revocationId)) fail('invalid')
    const row = await read(revocationId)
    if (!row) fail('invalid')
    return row!
  }
  return {
    fence: async (command: ManagedQuickBooksFenceCommand, authority, now) => {
      command = { ...command }
      authority = { ...authority }
      validAuthority(authority, now)
      if (
        !hex(command.revocationId) ||
        !hex(command.grantId) ||
        !Number.isSafeInteger(command.expectedConnectionGeneration) ||
        command.expectedConnectionGeneration < 0 ||
        command.expectedConnectionGeneration >= Number.MAX_SAFE_INTEGER ||
        !['sandbox', 'production'].includes(command.environment) ||
        !['disconnect', 'suspension', 'erasure'].includes(command.reason)
      )
        fail('invalid')
      if (command.expectedActorUserId !== authority.userId) fail('forbidden')
      const replay = async () => {
        const row = await read(command.revocationId)
        if (!row) return null
        const state = await facts(authority, now, command.grantId)
        if (
          row.grant_id !== command.grantId ||
          row.actor_id !== authority.userId ||
          row.expected_generation !== command.expectedConnectionGeneration ||
          row.environment !== command.environment ||
          row.reason !== command.reason
        )
          fail('conflict')
        return {
          outcome: 'replayed' as const,
          connectionGeneration: state.generation,
          revocation: receipt(row),
        }
      }
      const previous = await replay()
      if (previous) return previous
      try {
        const result = await atomic([
          {
            text: `INSERT INTO quickbooks_revocations(revocation_id,grant_id,actor_id,authority_kind,session_id,environment,reason,
              realm_id,expected_generation,fenced_generation,refresh_token,status,attempts,fenced_at)
              SELECT ?,?,?,?,?,?,?,c.realm_id,?,?,c.refresh_token,'pending',0,? FROM quickbooks_connections c
              WHERE c.id=1 AND c.disconnected_at IS NULL RETURNING revocation_id`,
            params: [
              command.revocationId,
              command.grantId,
              authority.userId,
              authority.kind,
              authority.kind === 'native-session' ? authority.sessionId : null,
              command.environment,
              command.reason,
              command.expectedConnectionGeneration,
              command.expectedConnectionGeneration + 1,
              now,
            ],
          },
          {
            // Provider credentials are retired locally in the same commit that
            // records the intent; only the intent row keeps the refresh token.
            text: `UPDATE quickbooks_connections SET disconnected_at=?,updated_at=?,access_token='-',refresh_token='-',
              access_token_expires_at=?,refresh_token_expires_at=?
              WHERE id=1 AND disconnected_at IS NULL AND EXISTS(SELECT 1 FROM quickbooks_revocations WHERE revocation_id=?) RETURNING id`,
            params: [now, now, placeholderTime, placeholderTime, command.revocationId],
          },
          {
            text: `SELECT ${columns} FROM quickbooks_revocations WHERE revocation_id=?`,
            params: [command.revocationId],
          },
          {
            text: 'SELECT generation FROM quickbooks_connection_generation WHERE singleton=1',
            params: [],
          },
        ])
        const row = result[2]?.[0] as Row | undefined
        const generation = result.at(-1)?.[0]?.generation
        if (!row || generation !== command.expectedConnectionGeneration + 1) fail('conflict')
        return {
          outcome: 'fenced' as const,
          connectionGeneration: generation as number,
          revocation: receipt(row!),
        }
      } catch (error) {
        const raced = await replay()
        if (raced) return raced
        if (error instanceof ManagedQuickBooksGrantError) throw error
        // Classify from current facts, never error text that could carry params.
        const state = await facts(authority, now, command.grantId)
        if (
          state.generation !== command.expectedConnectionGeneration ||
          !state.live ||
          state.grant_generation !== command.expectedConnectionGeneration
        )
          fail('conflict')
        throw error
      }
    },
    readRevocation: async (revocationId) => {
      if (!hex(revocationId)) fail('invalid')
      const row = await read(revocationId)
      return row ? receipt(row) : null
    },
    listUnresolved: async () =>
      (
        (
          await atomic([
            {
              text: `SELECT ${columns} FROM quickbooks_revocations WHERE status<>'revoked' ORDER BY fenced_at,revocation_id`,
              params: [],
            },
          ])
        )[0] as Row[]
      ).map(receipt),
    beginRevocation: async (revocationId, now) => {
      if (!hex(revocationId) || !validTime(now)) fail('invalid')
      const claimed = (
        await atomic([
          {
            text: `UPDATE quickbooks_revocations SET status='attempting',attempts=attempts+1
              WHERE revocation_id=? AND status='pending' RETURNING ${columns},refresh_token`,
            params: [revocationId],
          },
        ])
      )[0]?.[0] as (Row & { refresh_token: string }) | undefined
      if (!claimed) return { revocation: receipt(await required(revocationId)), custody: null }
      return {
        revocation: receipt(claimed),
        custody: {
          revocationId,
          realmId: claimed.realm_id,
          environment: claimed.environment,
          refreshToken: claimed.refresh_token,
        },
      }
    },
    settleRevocation: async (revocationId, outcome, now) => {
      if (!hex(revocationId) || !validTime(now) || !['revoked', 'not_revoked'].includes(outcome))
        fail('invalid')
      const settled = (
        await atomic([
          {
            text:
              outcome === 'revoked'
                ? `UPDATE quickbooks_revocations SET status='revoked',refresh_token=NULL,settled_at=?
                    WHERE revocation_id=? AND status='attempting' RETURNING ${columns}`
                : `UPDATE quickbooks_revocations SET status='pending'
                    WHERE revocation_id=? AND status='attempting' RETURNING ${columns}`,
            params: outcome === 'revoked' ? [now, revocationId] : [revocationId],
          },
        ])
      )[0]?.[0] as Row | undefined
      if (settled) return receipt(settled)
      const current = await required(revocationId)
      // Reporting the same success again is a replay; any other change is not.
      if (outcome === 'revoked' && current.status === 'revoked') return receipt(current)
      return fail('conflict')
    },
  }
}
