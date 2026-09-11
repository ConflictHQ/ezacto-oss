/**
 * Storage for the QuickBooks connection, the OAuth handshake, and what has been
 * mirrored where.
 *
 * The rules this enforces are in `0048_quickbooks_connection`; this is the
 * narrow surface the routes and the mirror use, so neither has to know the
 * table shapes.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface QuickBooksConnectionRecord {
  readonly realmId: string
  readonly companyName: string | null
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessTokenExpiresAt: string
  readonly refreshTokenExpiresAt: string
  readonly scope: string
  readonly allowOnlinePayment: boolean
  readonly connectedByUserId: number
  readonly connectedAt: string
  readonly disconnectedAt: string | null
}

export interface QuickBooksLinkRecord {
  readonly realmId: string
  readonly kind: 'customer' | 'invoice'
  readonly ezactoId: number
  readonly quickBooksId: string
  readonly syncToken: string
  readonly mirroredAt: string
}

interface ConnectionRow {
  realm_id: string
  company_name: string | null
  access_token: string
  refresh_token: string
  access_token_expires_at: string
  refresh_token_expires_at: string
  scope: string
  allow_online_payment: number
  connected_by_user_id: number
  connected_at: string
  disconnected_at: string | null
}

const connection = (row: ConnectionRow): QuickBooksConnectionRecord => ({
  realmId: row.realm_id,
  companyName: row.company_name,
  accessToken: row.access_token,
  refreshToken: row.refresh_token,
  accessTokenExpiresAt: row.access_token_expires_at,
  refreshTokenExpiresAt: row.refresh_token_expires_at,
  scope: row.scope,
  allowOnlinePayment: row.allow_online_payment === 1,
  connectedByUserId: row.connected_by_user_id,
  connectedAt: row.connected_at,
  disconnectedAt: row.disconnected_at,
})

export interface QuickBooksStore {
  /** The live connection, or null where there is none or it was disconnected. */
  readConnection(): Promise<QuickBooksConnectionRecord | null>
  beginAuthorization(input: {
    state: string
    userId: number
    redirectUri: string
    now: string
    expiresAt: string
  }): Promise<void>
  /**
   * Consumes the state and returns what it was issued for, or null when it is
   * unknown, expired, or already used. Single use is the point: a replayed
   * callback finds nothing.
   */
  consumeAuthorization(input: {
    state: string
    now: string
  }): Promise<{ userId: number; redirectUri: string } | null>
  saveConnection(input: {
    realmId: string
    accessToken: string
    refreshToken: string
    accessTokenExpiresAt: string
    refreshTokenExpiresAt: string
    scope: string
    connectedByUserId: number
    companyName: string | null
    now: string
  }): Promise<void>
  /** After a refresh. The rotated refresh token has to land before the next call. */
  saveTokens(input: {
    realmId: string
    accessToken: string
    refreshToken: string
    accessTokenExpiresAt: string
    refreshTokenExpiresAt: string
    now: string
  }): Promise<void>
  setAllowOnlinePayment(input: { allow: boolean; now: string }): Promise<void>
  disconnect(input: { now: string }): Promise<void>
  readLink(input: {
    realmId: string
    kind: 'customer' | 'invoice'
    ezactoId: number
  }): Promise<QuickBooksLinkRecord | null>
  saveLink(input: {
    realmId: string
    kind: 'customer' | 'invoice'
    ezactoId: number
    quickBooksId: string
    syncToken: string
    now: string
  }): Promise<void>
  /**
   * Records a delivery and says whether this caller is the one that should act
   * on it. A second delivery of the same change answers false rather than
   * recording a payment twice.
   */
  claimWebhookDelivery(input: {
    realmId: string
    entityName: string
    entityId: string
    operation: string
    lastUpdated: string
    now: string
  }): Promise<boolean>
  completeWebhookDelivery(input: {
    realmId: string
    entityName: string
    entityId: string
    operation: string
    lastUpdated: string
    now: string
    skippedReason?: string
  }): Promise<void>
}

export const createQuickBooksStore = (database: Database): QuickBooksStore => ({
  readConnection: async () => {
    const rows = await database.all<ConnectionRow>(sql`SELECT realm_id, company_name, access_token, refresh_token,
         access_token_expires_at, refresh_token_expires_at, scope,
         allow_online_payment, connected_by_user_id, connected_at, disconnected_at
       FROM quickbooks_connections WHERE id = 1 AND disconnected_at IS NULL`)
    return rows[0] === undefined ? null : connection(rows[0])
  },

  beginAuthorization: async (input) => {
    // Expired states are cleared here rather than by a job: this runs on every
    // connect attempt, which is often enough for a table that holds minutes of
    // data, and one fewer scheduled thing to forget.
    await database.run(sql`DELETE FROM quickbooks_oauth_states WHERE expires_at <= ${input.now}`)
    await database.run(sql`INSERT INTO quickbooks_oauth_states
         (state, requested_by_user_id, redirect_uri, created_at, expires_at)
       VALUES (${input.state}, ${input.userId}, ${input.redirectUri}, ${input.now}, ${input.expiresAt})`)
  },

  consumeAuthorization: async (input) => {
    const rows = await database.all<{ requested_by_user_id: number; redirect_uri: string }>(sql`DELETE FROM quickbooks_oauth_states
       WHERE state = ${input.state} AND expires_at > ${input.now}
       RETURNING requested_by_user_id, redirect_uri`)
    const row = rows[0]
    return row === undefined
      ? null
      : { userId: row.requested_by_user_id, redirectUri: row.redirect_uri }
  },

  saveConnection: async (input) => {
    // A previous connection is disconnected rather than overwritten, because the
    // realm is immutable while live -- connecting a different company is a new
    // connection, and the trigger says so.
    await database.run(sql`UPDATE quickbooks_connections
       SET disconnected_at = ${input.now}, updated_at = ${input.now}
       WHERE id = 1 AND disconnected_at IS NULL AND realm_id <> ${input.realmId}`)
    await database.run(sql`INSERT INTO quickbooks_connections
         (id, realm_id, company_name, access_token, refresh_token,
          access_token_expires_at, refresh_token_expires_at, scope,
          allow_online_payment, connected_by_user_id, connected_at,
          disconnected_at, created_at, updated_at)
       VALUES (1, ${input.realmId}, ${input.companyName}, ${input.accessToken}, ${input.refreshToken}, ${input.accessTokenExpiresAt}, ${input.refreshTokenExpiresAt}, ${input.scope}, 0, ${input.connectedByUserId}, ${input.now}, NULL, ${input.now}, ${input.now})
       ON CONFLICT(id) DO UPDATE SET
         realm_id = excluded.realm_id,
         company_name = excluded.company_name,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         access_token_expires_at = excluded.access_token_expires_at,
         refresh_token_expires_at = excluded.refresh_token_expires_at,
         scope = excluded.scope,
         connected_by_user_id = excluded.connected_by_user_id,
         connected_at = excluded.connected_at,
         disconnected_at = NULL,
         updated_at = excluded.updated_at`)
  },

  saveTokens: async (input) => {
    await database.run(sql`UPDATE quickbooks_connections
       SET access_token = ${input.accessToken}, refresh_token = ${input.refreshToken}, access_token_expires_at = ${input.accessTokenExpiresAt},
         refresh_token_expires_at = ${input.refreshTokenExpiresAt}, updated_at = ${input.now}
       WHERE id = 1 AND realm_id = ${input.realmId} AND disconnected_at IS NULL`)
  },

  setAllowOnlinePayment: async (input) => {
    await database.run(sql`UPDATE quickbooks_connections SET allow_online_payment = ${input.allow ? 1 : 0}, updated_at = ${input.now}
       WHERE id = 1 AND disconnected_at IS NULL`)
  },

  disconnect: async (input) => {
    await database.run(sql`UPDATE quickbooks_connections SET disconnected_at = ${input.now}, updated_at = ${input.now}
       WHERE id = 1 AND disconnected_at IS NULL`)
  },

  readLink: async (input) => {
    const rows = await database.all<{
      realm_id: string
      kind: 'customer' | 'invoice'
      ezacto_id: number
      quickbooks_id: string
      sync_token: string
      mirrored_at: string
    }>(sql`SELECT realm_id, kind, ezacto_id, quickbooks_id, sync_token, mirrored_at
       FROM quickbooks_links WHERE realm_id = ${input.realmId} AND kind = ${input.kind} AND ezacto_id = ${input.ezactoId}`)
    const row = rows[0]
    return row === undefined
      ? null
      : {
          realmId: row.realm_id,
          kind: row.kind,
          ezactoId: row.ezacto_id,
          quickBooksId: row.quickbooks_id,
          syncToken: row.sync_token,
          mirroredAt: row.mirrored_at,
        }
  },

  saveLink: async (input) => {
    // The sync token moves on every write; the identity does not, and the
    // trigger refuses an update that tries to change it.
    await database.run(sql`INSERT INTO quickbooks_links
         (realm_id, kind, ezacto_id, quickbooks_id, sync_token, mirrored_at,
          created_at, updated_at)
       VALUES (${input.realmId}, ${input.kind}, ${input.ezactoId}, ${input.quickBooksId}, ${input.syncToken}, ${input.now}, ${input.now}, ${input.now})
       ON CONFLICT(realm_id, kind, ezacto_id) DO UPDATE SET
         sync_token = excluded.sync_token,
         mirrored_at = excluded.mirrored_at,
         updated_at = excluded.updated_at`)
  },

  claimWebhookDelivery: async (input) => {
    // The insert is the claim. A second delivery of the same change collides on
    // the primary key, changes nothing, and returns no row -- which is how the
    // caller learns somebody already has it.
    const rows = await database.all<{ entity_id: string }>(sql`INSERT INTO quickbooks_webhook_deliveries
         (realm_id, entity_name, entity_id, operation, last_updated, received_at)
       VALUES (${input.realmId}, ${input.entityName}, ${input.entityId}, ${input.operation}, ${input.lastUpdated}, ${input.now})
       ON CONFLICT DO NOTHING
       RETURNING entity_id`)
    return rows.length > 0
  },

  completeWebhookDelivery: async (input) => {
    await database.run(sql`UPDATE quickbooks_webhook_deliveries
       SET processed_at = ${input.now}, skipped_reason = ${input.skippedReason ?? null}
       WHERE realm_id = ${input.realmId} AND entity_name = ${input.entityName}
         AND entity_id = ${input.entityId} AND operation = ${input.operation}
         AND last_updated = ${input.lastUpdated}`)
  },
})
