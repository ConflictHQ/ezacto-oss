import {
  ManagedWiseConnectionError,
  managedWiseLimits,
  type ManagedWiseAuthority,
  type ManagedWiseConnectionState,
  type ManagedWiseConnectionStatus,
  type ManagedWiseConnectionStore,
} from '@ezacto/core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
const fail = (kind: ManagedWiseConnectionError['kind']): never => {
  throw new ManagedWiseConnectionError(kind)
}
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
const validAuthority = (authority: ManagedWiseAuthority, now: string) => {
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

interface Row {
  generation: number
  status: ManagedWiseConnectionStatus
  profile_id: string | null
  sealed_credential: string | null
}
const state = (row: Row): ManagedWiseConnectionState => ({
  generation: row.generation,
  status: row.status,
  profileId: row.profile_id,
})
const columns = 'generation,status,profile_id,sealed_credential'

/** Stores sealed envelopes and lifecycle facts only: no statement here can
 * decrypt a credential, and no provider call can occur in this module. The
 * authority fence is repeated in SQL, inside the same atomic command. */
export const createManagedWiseConnectionStore = (
  database: Database,
): ManagedWiseConnectionStore => {
  const atomic = (statements: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(database as InvoiceStateDatabase, statements)
  const read = async (): Promise<Row> => {
    const row = (
      await atomic([
        { text: `SELECT ${columns} FROM wise_managed_connection WHERE singleton=1`, params: [] },
      ])
    )[0]?.[0] as unknown as Row | undefined
    if (!row) return fail('conflict')
    return row
  }
  const authorized = async (authority: ManagedWiseAuthority, now: string, fresh = false) => {
    validAuthority(authority, now)
    const rows = await atomic([
      {
        text: `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile='administrator') AND
          (?=1 OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL
            AND julianday(idle_expires_at)>julianday(?) AND julianday(absolute_expires_at)>julianday(?) AND profile_snapshot='administrator'
            AND (?=0 OR (julianday(created_at)<=julianday(?) AND julianday(created_at)>=julianday(?))))) AS ok`,
        params: [
          authority.userId,
          authority.kind === 'guarded-session' ? 1 : 0,
          authority.kind === 'native-session' ? authority.sessionId : 0,
          authority.userId,
          now,
          now,
          fresh ? 1 : 0,
          now,
          new Date(Date.parse(now) - managedWiseLimits.freshSessionMs).toISOString(),
        ],
      },
    ])
    if (!rows[0]?.[0]?.ok) fail('forbidden')
  }
  const receipt = async (commandId: string) =>
    (
      await atomic([
        {
          text: `SELECT actor_id,action,fingerprint,accepted_generation FROM wise_managed_commands WHERE command_id=?`,
          params: [commandId],
        },
      ])
    )[0]?.[0] as
      | { actor_id: number; action: string; fingerprint: string; accepted_generation: number }
      | undefined
  return {
    state: async () => state(await read()),
    prepare: async (authority, now) => {
      await authorized(authority, now)
      return state(await read())
    },
    apply: async (command, authority, now) => {
      authority = { ...authority }
      validAuthority(authority, now)
      if (
        !hex(command.commandId) ||
        !hex(command.fingerprint) ||
        command.expectedActorUserId !== authority.userId ||
        !Number.isSafeInteger(command.expectedGeneration) ||
        command.expectedGeneration < 0 ||
        command.expectedGeneration >= Number.MAX_SAFE_INTEGER ||
        (command.action !== 'connect' && command.action !== 'disconnect')
      )
        return fail('invalid')
      if (
        command.action === 'connect' &&
        (typeof command.profileId !== 'string' ||
          !command.profileId.trim() ||
          command.profileId !== command.profileId.trim() ||
          !/^[1-9][0-9]{0,63}$/u.test(command.profileId) ||
          typeof command.sealed !== 'string' ||
          command.sealed.length < 1 ||
          command.sealed.length > 8192)
      )
        return fail('invalid')
      const replay = async () => {
        await authorized(authority, now, true)
        const previous = await receipt(command.commandId)
        if (!previous) return null
        const current = await read()
        if (
          previous.actor_id !== authority.userId ||
          previous.action !== command.action ||
          previous.fingerprint !== command.fingerprint ||
          previous.accepted_generation !== current.generation
        )
          return fail('conflict')
        return { ...state(current), outcome: 'replayed' as const }
      }
      const previous = await replay()
      if (previous) return previous
      const connect = command.action === 'connect'
      try {
        const result = await atomic([
          {
            text: `INSERT INTO wise_managed_commands(command_id,actor_id,authority_kind,session_id,action,profile_id,
              fingerprint,expected_generation,accepted_generation,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING command_id`,
            params: [
              command.commandId,
              authority.userId,
              authority.kind,
              authority.kind === 'native-session' ? authority.sessionId : null,
              command.action,
              connect ? command.profileId : null,
              command.fingerprint,
              command.expectedGeneration,
              command.expectedGeneration + 1,
              now,
            ],
          },
          connect
            ? {
                text: `UPDATE wise_managed_connection SET generation=generation+1,status='configured',
                  profile_id=?,sealed_credential=?,
                  connected_by_user_id=?,health_at=NULL,updated_at=? WHERE singleton=1 AND generation=? RETURNING generation`,
                params: [
                  command.profileId,
                  command.sealed,
                  authority.userId,
                  now,
                  command.expectedGeneration,
                ],
              }
            : {
                text: `UPDATE wise_managed_connection SET generation=generation+1,status='disconnected',
                  profile_id=NULL,sealed_credential=NULL,connected_by_user_id=NULL,
                  health_at=NULL,updated_at=? WHERE singleton=1 AND generation=? RETURNING generation`,
                params: [now, command.expectedGeneration],
              },
          { text: `SELECT ${columns} FROM wise_managed_connection WHERE singleton=1`, params: [] },
        ])
        const row = result.at(-1)?.[0] as unknown as Row | undefined
        if (!row || row.generation !== command.expectedGeneration + 1) return fail('conflict')
        return { ...state(row), outcome: 'applied' as const }
      } catch (error) {
        const raced = await replay().catch(() => null)
        if (raced) return raced
        if (error instanceof ManagedWiseConnectionError) throw error
        // Classify from current facts, never driver text: it can echo bound params.
        if ((await read()).generation !== command.expectedGeneration) return fail('conflict')
        await authorized(authority, now, true)
        throw error
      }
    },
    readSealed: async () => {
      const row = await read()
      return row.status === 'disconnected' || row.sealed_credential === null
        ? null
        : { ...state(row), sealed: row.sealed_credential }
    },
    recordHealth: async (generation, healthy, now) => {
      if (!validTime(now) || !Number.isSafeInteger(generation)) return fail('invalid')
      await atomic([
        {
          text: `UPDATE wise_managed_connection SET status=?,health_at=? WHERE singleton=1 AND generation=?
            AND status IN ('configured','connected','unavailable') RETURNING generation`,
          params: [healthy ? 'connected' : 'unavailable', now, generation],
        },
      ])
    },
    erase: async (now) => {
      if (!validTime(now)) return fail('invalid')
      await atomic([
        {
          text: `UPDATE wise_managed_connection SET generation=generation+1,status='disconnected',profile_id=NULL,
            sealed_credential=NULL,connected_by_user_id=NULL,health_at=NULL,updated_at=?
            WHERE singleton=1 RETURNING generation`,
          params: [now],
        },
        { text: 'DELETE FROM wise_managed_commands RETURNING command_id', params: [] },
      ])
    },
    inventory: async () => {
      const rows = await atomic([
        {
          text: `SELECT (SELECT count(*) FROM wise_managed_connection WHERE sealed_credential IS NOT NULL) AS sealed,
            (SELECT count(*) FROM wise_managed_commands) AS receipts`,
          params: [],
        },
      ])
      return {
        sealedCredentials: Number(rows[0]?.[0]?.sealed),
        commandReceipts: Number(rows[0]?.[0]?.receipts),
      }
    },
  }
}
