import {
  ManagedQuickBooksGrantError,
  managedQuickBooksGrantLimits,
  type ManagedQuickBooksAuthority,
  type ManagedQuickBooksGrantCommand,
  type ManagedQuickBooksGrantProbe,
  type ManagedQuickBooksGrantStore,
} from '@ezacto/core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { quickBooksConnectionStatements } from './quickbooks-connection-command.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
export function fail(kind: ManagedQuickBooksGrantError['kind']): never {
  throw new ManagedQuickBooksGrantError(kind)
}
export const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const validTime = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false
  return (
    new Date(value).toISOString() === value ||
    new Date(value).toISOString().replace('.000Z', 'Z') === value
  )
}
const validProbe = (probe: ManagedQuickBooksGrantProbe) => {
  if (!hex(probe.grantId) || !hex(probe.browserHash) || !hex(probe.credentialHash)) fail('invalid')
}
export const validAuthority = (authority: ManagedQuickBooksAuthority, now: string) => {
  if (
    !validTime(now) ||
    !Number.isSafeInteger(authority.userId) ||
    authority.userId < 1 ||
    !['native-session', 'guarded-session'].includes(authority.kind) ||
    (authority.kind === 'native-session' &&
      (!Number.isSafeInteger(authority.sessionId) || authority.sessionId < 1))
  )
    fail('forbidden')
}
const fingerprint = async (command: ManagedQuickBooksGrantCommand): Promise<string> => {
  const token = command.tokens
  const encoded = JSON.stringify([
    command.grantId,
    command.browserHash,
    command.credentialHash,
    command.expectedActorUserId,
    command.expectedConnectionGeneration,
    command.expiresAt,
    token.realmId,
    token.companyName,
    token.scope,
    token.accessToken,
    token.refreshToken,
    token.accessTokenExpiresAt,
    token.refreshTokenExpiresAt,
  ])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

type State = {
  generation: number
  authorized: number
  blocked: number
  realm_id: string | null
  connected_by_user_id: number | null
  connected_at: string | null
  disconnected_at: string | null
}
type Receipt = {
  actor_id: number
  browser_hash: string
  credential_hash: string
  command_fingerprint: string
  accepted_generation: number
  realm_id: string
  expires_at: number
  recorded_at: string
}
const connected = (state: State) => state.realm_id !== null && state.disconnected_at === null
const assertReceipt = (
  receipt: Receipt,
  probe: ManagedQuickBooksGrantProbe,
  authority: ManagedQuickBooksAuthority,
  state: State,
  now: string,
) => {
  if (
    receipt.actor_id !== authority.userId ||
    receipt.browser_hash !== probe.browserHash ||
    receipt.credential_hash !== probe.credentialHash ||
    receipt.accepted_generation !== state.generation ||
    !connected(state) ||
    receipt.realm_id !== state.realm_id ||
    receipt.actor_id !== state.connected_by_user_id ||
    receipt.recorded_at !== state.connected_at
  )
    fail('conflict')
  if (receipt.expires_at <= Date.parse(now)) fail('expired')
}

/** Receipt contains only hashes/bindings, never recoverable token material.
 * Native session revocation and active administrator checks are repeated in the
 * SQL insert guard, within the same atomic batch as the canonical connection.
 */
export const createManagedQuickBooksGrantStore = (
  database: Database,
): ManagedQuickBooksGrantStore => {
  const atomic = (statements: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(database as InvoiceStateDatabase, statements)
  const snapshot = async (
    authority: ManagedQuickBooksAuthority,
    now: string,
    probe?: ManagedQuickBooksGrantProbe,
  ) => {
    validAuthority(authority, now)
    if (probe) validProbe(probe)
    const result = await atomic([
      {
        text: `SELECT g.generation,c.realm_id,c.connected_by_user_id,c.connected_at,c.disconnected_at,
          (EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile='administrator') AND
            (?=1 OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL
              AND julianday(idle_expires_at)>julianday(?) AND julianday(absolute_expires_at)>julianday(?) AND profile_snapshot='administrator'))) AS authorized,
          EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL)) AS blocked
          FROM quickbooks_connection_generation g LEFT JOIN quickbooks_connections c ON c.id=1 WHERE g.singleton=1`,
        params: [
          authority.userId,
          authority.kind === 'guarded-session' ? 1 : 0,
          authority.kind === 'native-session' ? authority.sessionId : 0,
          authority.userId,
          now,
          now,
        ],
      },
      ...(probe
        ? [
            {
              text: `SELECT actor_id,browser_hash,credential_hash,command_fingerprint,accepted_generation,realm_id,expires_at,recorded_at
          FROM quickbooks_managed_grants WHERE grant_id=?`,
              params: [probe.grantId],
            },
          ]
        : []),
    ])
    const state = result[0]?.[0] as State | undefined
    if (!state || !Number.isSafeInteger(state.generation) || state.generation < 0 || state.blocked)
      fail('conflict')
    if (!state.authorized) fail('forbidden')
    return { state, receipt: result[1]?.[0] as Receipt | undefined }
  }
  return {
    prepare: async (authority, now) => {
      const { state } = await snapshot(authority, now)
      return { connectionGeneration: state.generation, connected: connected(state) }
    },
    inspect: async (probe, authority, now) => {
      probe = { ...probe }
      authority = { ...authority }
      const { state, receipt } = await snapshot(authority, now, probe)
      if (receipt) assertReceipt(receipt, probe, authority, state, now)
      return {
        connectionGeneration: state.generation,
        connected: connected(state),
        replayed: !!receipt,
      }
    },
    accept: async (command, authority, now) => {
      command = { ...command, tokens: { ...command.tokens } }
      authority = { ...authority }
      validAuthority(authority, now)
      validProbe(command)
      if (command.expectedActorUserId !== authority.userId) fail('forbidden')
      const token = command.tokens
      if (
        !Number.isSafeInteger(command.expectedConnectionGeneration) ||
        command.expectedConnectionGeneration < 0 ||
        command.expectedConnectionGeneration >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(command.expiresAt) ||
        command.expiresAt > 8_640_000_000_000_000 ||
        !token ||
        typeof token.realmId !== 'string' ||
        !token.realmId.trim() ||
        token.realmId !== token.realmId.trim() ||
        token.realmId.length > managedQuickBooksGrantLimits.realmIdLength ||
        /[\p{Cc}]/u.test(token.realmId) ||
        (token.companyName !== null &&
          (typeof token.companyName !== 'string' ||
            token.companyName.length > managedQuickBooksGrantLimits.companyNameLength)) ||
        token.scope !== 'com.intuit.quickbooks.accounting' ||
        [token.accessToken, token.refreshToken].some(
          (value) =>
            typeof value !== 'string' ||
            value.length < 1 ||
            value.length > managedQuickBooksGrantLimits.tokenLength ||
            /\s/u.test(value),
        ) ||
        !validTime(token.accessTokenExpiresAt) ||
        !validTime(token.refreshTokenExpiresAt)
      )
        fail('invalid')
      if (command.expiresAt <= Date.parse(now)) fail('expired')
      const digest = await fingerprint(command)
      const replay = async () => {
        const { state, receipt } = await snapshot(authority, now, command)
        if (!receipt) return null
        assertReceipt(receipt, command, authority, state, now)
        if (receipt.command_fingerprint !== digest) fail('conflict')
        return {
          outcome: 'replayed' as const,
          connectionGeneration: state.generation,
          connected: true,
        }
      }
      const previous = await replay()
      if (previous) return previous
      if (
        Date.parse(token.accessTokenExpiresAt) <= Date.parse(now) ||
        Date.parse(token.refreshTokenExpiresAt) <= Date.parse(now)
      )
        fail('expired')
      try {
        const result = await atomic([
          {
            text: `INSERT INTO quickbooks_managed_grants(grant_id,actor_id,authority_kind,session_id,browser_hash,credential_hash,
              command_fingerprint,expected_generation,accepted_generation,realm_id,expires_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING grant_id`,
            params: [
              command.grantId,
              authority.userId,
              authority.kind,
              authority.kind === 'native-session' ? authority.sessionId : null,
              command.browserHash,
              command.credentialHash,
              digest,
              command.expectedConnectionGeneration,
              command.expectedConnectionGeneration + 1,
              token.realmId,
              command.expiresAt,
              now,
            ],
          },
          ...quickBooksConnectionStatements({ ...token, connectedByUserId: authority.userId, now }),
          {
            text: 'SELECT generation FROM quickbooks_connection_generation WHERE singleton=1',
            params: [],
          },
        ])
        const generation = result.at(-1)?.[0]?.generation
        if (
          typeof generation !== 'number' ||
          generation !== command.expectedConnectionGeneration + 1
        )
          fail('conflict')
        return { outcome: 'accepted' as const, connectionGeneration: generation, connected: true }
      } catch (error) {
        // A racing exact command or lost response may already have committed.
        // Fresh authority and current incarnation are checked before replay.
        const raced = await replay()
        if (raced) return raced
        if (error instanceof ManagedQuickBooksGrantError) throw error
        // Classify conflicts from current canonical facts, never error strings:
        // driver wrappers can include token/company params in their messages.
        const { state } = await snapshot(authority, now)
        if (state.generation !== command.expectedConnectionGeneration || connected(state))
          fail('conflict')
        throw error
      }
    },
  }
}
