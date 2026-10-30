import {
  ManagedDeelConnectionError,
  managedDeelLimits,
  type ManagedDeelAuthority,
  type ManagedDeelConnectionStore,
  type ManagedDeelState,
} from '@ezacto/core'
import type { ManagedDeelCredentialSource } from '@ezacto/integrations'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

const fail = (kind: ManagedDeelConnectionError['kind']): never => {
  throw new ManagedDeelConnectionError(kind)
}
const validTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
const validDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\d$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const validGeneration = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) < Number.MAX_SAFE_INTEGER

const checkAuthority = (authority: ManagedDeelAuthority, now: string): void => {
  if (
    !validTime(now) ||
    !Number.isSafeInteger(authority.userId) ||
    authority.userId < 1 ||
    (authority.kind === 'native-session' &&
      (!Number.isSafeInteger(authority.sessionId) || authority.sessionId < 1)) ||
    (authority.kind !== 'native-session' && authority.kind !== 'guarded-session')
  )
    fail('forbidden')
}

/**
 * Current active administrator, and for a native session one that is unrevoked,
 * unexpired and signed in within `freshSessionMs`. A guarded session's freshness
 * is the host's to prove. Also refuses while a data migration is loading.
 * Placeholders, in order: user, guarded flag, session, user, now, now, cutoff.
 */
const authorizedSql = `(EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile='administrator')
  AND (?=1 OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL
    AND julianday(idle_expires_at)>julianday(?) AND julianday(absolute_expires_at)>julianday(?)
    AND profile_snapshot='administrator' AND julianday(created_at)>=julianday(?)))
  AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed'
    AND (status<>'cancelled' OR started_at IS NOT NULL)))`

const authorityParams = (
  authority: ManagedDeelAuthority,
  now: string,
  fresh: boolean,
): unknown[] => [
  authority.userId,
  authority.kind === 'guarded-session' ? 1 : 0,
  authority.kind === 'native-session' ? authority.sessionId : 0,
  authority.userId,
  now,
  now,
  fresh
    ? new Date(Date.parse(now) - managedDeelLimits.freshSessionMs).toISOString()
    : '1970-01-01T00:00:00.000Z',
]

interface StateRow {
  generation: number
  authorized: number
  start_date: string | null
  connected_at: string | null
  connected_by_user_id: number | null
}

const stateOf = (row: StateRow): ManagedDeelState => ({
  generation: row.generation,
  connected: row.start_date !== null,
  startDate: row.start_date,
  connectedAt: row.connected_at,
  connectedByUserId: row.connected_by_user_id,
})

/**
 * The tenant's Deel connection. Every command repeats the administrator and
 * session fence inside its own SQL, so a revoked or stale session cannot write
 * even if it passed an earlier check. The token is written here and read only by
 * `createDeelCredentialSource`; no read in this store returns it.
 */
export const createManagedDeelConnectionStore = (
  database: Database,
): ManagedDeelConnectionStore => {
  const atomic = (statements: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(database as InvoiceStateDatabase, statements)
  const read = (authority: ManagedDeelAuthority, now: string, fresh: boolean) => ({
    text: `SELECT g.generation, ${authorizedSql} AS authorized,
        c.start_date, c.connected_at, c.connected_by_user_id
      FROM deel_connection_generation g LEFT JOIN deel_connection c ON c.id=1 WHERE g.singleton=1`,
    params: authorityParams(authority, now, fresh),
  })
  /** `fresh` is for classifying a refused write; plain reads only need a live session. */
  const snapshot = async (
    authority: ManagedDeelAuthority,
    now: string,
    fresh: boolean,
  ): Promise<StateRow> => {
    const row = (await atomic([read(authority, now, fresh)]))[0]?.[0] as unknown as
      StateRow | undefined
    if (row === undefined || !validGeneration(row.generation)) return fail('conflict')
    if (!row.authorized) return fail('forbidden')
    return row
  }
  const guard = `g.singleton=1 AND g.generation=? AND ${authorizedSql}`

  return {
    state: async (authority, now) => {
      checkAuthority(authority, now)
      return stateOf(await snapshot(authority, now, false))
    },

    connect: async (command, authority, now) => {
      command = { ...command }
      authority = { ...authority }
      checkAuthority(authority, now)
      if (command.expectedActorUserId !== authority.userId) fail('forbidden')
      if (
        !validGeneration(command.expectedGeneration) ||
        typeof command.token !== 'string' ||
        command.token.length < 1 ||
        command.token.length > managedDeelLimits.tokenLength ||
        !/^[!-~]+$/.test(command.token) ||
        !validDate(command.startDate)
      )
        fail('invalid')
      let result: Record<string, unknown>[][]
      try {
        result = await atomic([
          {
            text: `INSERT INTO deel_connection(id,token,start_date,connected_by_user_id,connected_at,updated_at)
              SELECT 1,?,?,?,?,? FROM deel_connection_generation g WHERE ${guard}
              ON CONFLICT(id) DO UPDATE SET token=excluded.token,start_date=excluded.start_date,
                connected_by_user_id=excluded.connected_by_user_id,updated_at=excluded.updated_at
              RETURNING id`,
            params: [
              command.token,
              command.startDate,
              authority.userId,
              now,
              now,
              command.expectedGeneration,
              ...authorityParams(authority, now, true),
            ],
          },
        ])
      } catch {
        // Never surface the driver error: it can carry the bound token.
        return fail('conflict')
      }
      if (result[0]?.length !== 1) {
        // Classify from current facts, never from error text.
        await snapshot(authority, now, true)
        return fail('conflict')
      }
      return stateOf(await snapshot(authority, now, false))
    },

    disconnect: async (command, authority, now) => {
      command = { ...command }
      authority = { ...authority }
      checkAuthority(authority, now)
      if (command.expectedActorUserId !== authority.userId) fail('forbidden')
      if (!validGeneration(command.expectedGeneration)) fail('invalid')
      const params = [command.expectedGeneration, ...authorityParams(authority, now, true)]
      const result = await atomic([
        // Nothing connected: still advance, so an in-flight command cannot outlive it.
        {
          text: `UPDATE deel_connection_generation AS g SET generation=generation+1
            WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM deel_connection WHERE id=1)
            RETURNING generation`,
          params,
        },
        // The delete trigger advances the generation and returns the sync to manual.
        {
          text: `DELETE FROM deel_connection WHERE id=1 AND EXISTS(
            SELECT 1 FROM deel_connection_generation g WHERE ${guard}) RETURNING id`,
          params,
        },
      ])
      if ((result[0]?.length ?? 0) + (result[1]?.length ?? 0) !== 1) {
        await snapshot(authority, now, true)
        return fail('conflict')
      }
      return stateOf(await snapshot(authority, now, false))
    },
  }
}

/**
 * Trusted, in-process read of the stored credential for the managed runtime.
 * Takes no tenant and no authority: it is bound to the one database it was
 * given, and is never exposed over HTTP.
 */
export const createDeelCredentialSource = (database: Database): ManagedDeelCredentialSource => {
  const atomic = (statements: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(database as InvoiceStateDatabase, statements)
  return {
    current: async () => {
      const row = (
        await atomic([
          {
            text: `SELECT c.token, c.start_date, g.generation FROM deel_connection c
              JOIN deel_connection_generation g ON g.singleton=1 WHERE c.id=1`,
            params: [],
          },
        ])
      )[0]?.[0] as { token: string; start_date: string; generation: number } | undefined
      return row === undefined
        ? null
        : { token: row.token, startDate: row.start_date, generation: row.generation }
    },
    generation: async () => {
      const row = (
        await atomic([
          {
            text: `SELECT generation FROM deel_connection_generation WHERE singleton=1`,
            params: [],
          },
        ])
      )[0]?.[0] as { generation: number } | undefined
      if (row === undefined) throw new Error('deel_connection_generation has no row')
      return row.generation
    },
  }
}
