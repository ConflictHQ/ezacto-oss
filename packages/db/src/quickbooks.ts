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

export type QuickBooksMirrorOutcomeKind =
  | 'created'
  | 'updated'
  | 'adopted'
  | 'linked'
  | 'refused'
  | 'failed'

/** The most recent mirror attempt for an invoice (issue 819). */
export interface QuickBooksMirrorOutcomeRecord {
  readonly invoiceId: number
  readonly realmId: string | null
  readonly kind: QuickBooksMirrorOutcomeKind
  readonly reason: string | null
  readonly quickBooksId: string | null
  readonly attemptedAt: string
}

export type QuickBooksSyncOutcome = 'caught_up' | 'failed' | 'full_reconcile_needed'

/** Where change-data-capture catch-up resumes for a company (issue 1013). */
export interface QuickBooksSyncCursorRecord {
  readonly cdcCursor: string
  readonly lastRunAt: string
  readonly lastOutcome: QuickBooksSyncOutcome
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
  /** A receipt of ours and the QuickBooks payment it became (issue 799). */
  readPaymentLink(input: {
    realmId: string
    paymentId: number
  }): Promise<{ quickBooksId: string; syncToken: string; mirroredAt: string } | null>
  savePaymentLink(input: {
    realmId: string
    paymentId: number
    quickBooksId: string
    syncToken: string
    now: string
  }): Promise<void>
  /**
   * The other way round: which receipt of ours a QuickBooks payment was made
   * from. The webhook asks, because QuickBooks announces the payments the
   * mirror creates like any other, and one of ours must not come back as a
   * second receipt. `quickbooks_payment_links_remote` keeps it to one.
   */
  readPaymentLinkByQuickBooksId(input: {
    realmId: string
    quickBooksId: string
  }): Promise<{ paymentId: number } | null>
  /**
   * The result of the latest mirror attempt for an invoice, whichever way it
   * went, overwritten on every attempt (issue 819). This is what lets the
   * invoice page say "not synced, because ..." without a sync ever being
   * pressed.
   */
  recordMirrorOutcome(input: {
    invoiceId: number
    realmId: string | null
    kind: QuickBooksMirrorOutcomeKind
    reason: string | null
    quickBooksId: string | null
    now: string
  }): Promise<void>
  readMirrorOutcome(invoiceId: number): Promise<QuickBooksMirrorOutcomeRecord | null>
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
  /**
   * Claims a change catch-up found, unless it was already processed under any
   * operation: the webhook says Create where catch-up can only see an update,
   * and one change must not be applied twice. A claim never completed (a
   * crash between accepting and handling) is taken over.
   */
  claimRecoveredDelivery(input: {
    realmId: string
    entityName: string
    entityId: string
    operation: string
    lastUpdated: string
    now: string
  }): Promise<boolean>
  readSyncCursor(realmId: string): Promise<QuickBooksSyncCursorRecord | null>
  /** Places or moves the cursor, with the outcome of the run that did. */
  saveSyncCursor(input: {
    realmId: string
    cdcCursor: string
    lastRunAt: string
    lastOutcome: QuickBooksSyncOutcome
  }): Promise<void>
  /** Records how a run ended without moving the cursor. */
  recordSyncOutcome(input: {
    realmId: string
    lastRunAt: string
    lastOutcome: QuickBooksSyncOutcome
  }): Promise<void>
  /**
   * Notes that a QuickBooks payment was voided or deleted there, and answers
   * whether a receipt of ours came from it. Writes only where one did. It never
   * touches a receipt, an invoice or QuickBooks, and repeating it changes
   * nothing; a report older than the one held is ignored.
   */
  flagPaymentDivergence(input: {
    realmId: string
    quickBooksPaymentId: string
    kind: 'voided' | 'deleted'
    quickBooksUpdatedAt: string
    now: string
  }): Promise<boolean>
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
  readPaymentLink: async (input) => {
    const rows = await database.all<{
      quickbooks_id: string
      sync_token: string
      mirrored_at: string
    }>(sql`SELECT quickbooks_id, sync_token, mirrored_at
       FROM quickbooks_payment_links
       WHERE realm_id = ${input.realmId} AND payment_id = ${input.paymentId}`)
    const row = rows[0]
    return row === undefined
      ? null
      : { quickBooksId: row.quickbooks_id, syncToken: row.sync_token, mirroredAt: row.mirrored_at }
  },
  savePaymentLink: async (input) => {
    await database.run(sql`INSERT INTO quickbooks_payment_links
         (realm_id, payment_id, quickbooks_id, sync_token, mirrored_at, created_at, updated_at)
       VALUES (${input.realmId}, ${input.paymentId}, ${input.quickBooksId}, ${input.syncToken}, ${input.now}, ${input.now}, ${input.now})
       ON CONFLICT(realm_id, payment_id) DO UPDATE SET
         sync_token = excluded.sync_token,
         mirrored_at = excluded.mirrored_at,
         updated_at = excluded.updated_at`)
  },

  readPaymentLinkByQuickBooksId: async (input) => {
    const rows = await database.all<{ payment_id: number }>(sql`SELECT payment_id
       FROM quickbooks_payment_links
       WHERE realm_id = ${input.realmId} AND quickbooks_id = ${input.quickBooksId}`)
    const row = rows[0]
    return row === undefined ? null : { paymentId: row.payment_id }
  },

  recordMirrorOutcome: async (input) => {
    await database.run(sql`INSERT INTO quickbooks_mirror_outcomes
         (invoice_id, realm_id, kind, reason, quickbooks_id, attempted_at)
       VALUES (${input.invoiceId}, ${input.realmId}, ${input.kind}, ${input.reason}, ${input.quickBooksId}, ${input.now})
       ON CONFLICT(invoice_id) DO UPDATE SET
         realm_id = excluded.realm_id,
         kind = excluded.kind,
         reason = excluded.reason,
         quickbooks_id = excluded.quickbooks_id,
         attempted_at = excluded.attempted_at`)
  },

  readMirrorOutcome: async (invoiceId) => {
    const rows = await database.all<{
      invoice_id: number
      realm_id: string | null
      kind: QuickBooksMirrorOutcomeKind
      reason: string | null
      quickbooks_id: string | null
      attempted_at: string
    }>(sql`SELECT invoice_id, realm_id, kind, reason, quickbooks_id, attempted_at
       FROM quickbooks_mirror_outcomes WHERE invoice_id = ${invoiceId}`)
    const row = rows[0]
    return row === undefined
      ? null
      : {
          invoiceId: row.invoice_id,
          realmId: row.realm_id,
          kind: row.kind,
          reason: row.reason,
          quickBooksId: row.quickbooks_id,
          attemptedAt: row.attempted_at,
        }
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

  claimRecoveredDelivery: async (input) => {
    // The webhook and catch-up describe one change differently (Create versus
    // Update), so "already handled" ignores the operation: same payment, same
    // instant, processed under any name.
    const handled = await database.all<{ entity_id: string }>(sql`SELECT entity_id
       FROM quickbooks_webhook_deliveries
       WHERE realm_id = ${input.realmId} AND entity_name = ${input.entityName}
         AND entity_id = ${input.entityId} AND last_updated = ${input.lastUpdated}
         AND processed_at IS NOT NULL`)
    if (handled.length > 0) return false
    await database.run(sql`INSERT INTO quickbooks_webhook_deliveries
         (realm_id, entity_name, entity_id, operation, last_updated, received_at)
       VALUES (${input.realmId}, ${input.entityName}, ${input.entityId}, ${input.operation}, ${input.lastUpdated}, ${input.now})
       ON CONFLICT DO NOTHING`)
    return true
  },

  readSyncCursor: async (realmId) => {
    const rows = await database.all<{
      cdc_cursor: string
      last_run_at: string
      last_outcome: QuickBooksSyncOutcome
    }>(sql`SELECT cdc_cursor, last_run_at, last_outcome
       FROM quickbooks_sync_cursors WHERE realm_id = ${realmId}`)
    const row = rows[0]
    return row === undefined
      ? null
      : { cdcCursor: row.cdc_cursor, lastRunAt: row.last_run_at, lastOutcome: row.last_outcome }
  },

  saveSyncCursor: async (input) => {
    await database.run(sql`INSERT INTO quickbooks_sync_cursors
         (realm_id, cdc_cursor, last_run_at, last_outcome)
       VALUES (${input.realmId}, ${input.cdcCursor}, ${input.lastRunAt}, ${input.lastOutcome})
       ON CONFLICT(realm_id) DO UPDATE SET
         cdc_cursor = excluded.cdc_cursor,
         last_run_at = excluded.last_run_at,
         last_outcome = excluded.last_outcome`)
  },

  recordSyncOutcome: async (input) => {
    await database.run(sql`UPDATE quickbooks_sync_cursors
       SET last_run_at = ${input.lastRunAt}, last_outcome = ${input.lastOutcome}
       WHERE realm_id = ${input.realmId}`)
  },

  flagPaymentDivergence: async (input) => {
    // A receipt "came from" a QuickBooks payment when QuickBooks recorded it
    // (its provider reference is `<payment>:<invoice>`, or the bare id on an
    // older one) or when the mirror made the payment from a receipt of ours.
    await database.run(sql`INSERT INTO quickbooks_payment_divergences
         (realm_id, quickbooks_payment_id, kind, quickbooks_updated_at, detected_at)
       SELECT ${input.realmId}, ${input.quickBooksPaymentId}, ${input.kind}, ${input.quickBooksUpdatedAt}, ${input.now}
       WHERE EXISTS (
         SELECT 1 FROM invoice_payments p
         WHERE (p.provider = 'quickbooks'
             AND (p.provider_transaction_id = ${input.quickBooksPaymentId}
               OR substr(p.provider_transaction_id, 1, length(${input.quickBooksPaymentId}) + 1) = ${input.quickBooksPaymentId} || ':')
             AND p.provider_account_id IN (
               SELECT id FROM payment_provider_accounts
               WHERE provider = 'quickbooks' AND external_account_id = ${input.realmId}))
           OR p.id IN (
             SELECT payment_id FROM quickbooks_payment_links
             WHERE realm_id = ${input.realmId} AND quickbooks_id = ${input.quickBooksPaymentId}))
       ON CONFLICT(realm_id, quickbooks_payment_id) DO UPDATE SET
         kind = excluded.kind,
         quickbooks_updated_at = excluded.quickbooks_updated_at
       WHERE excluded.quickbooks_updated_at >= quickbooks_payment_divergences.quickbooks_updated_at`)
    const flagged = await database.all<{ kind: string }>(sql`SELECT kind
       FROM quickbooks_payment_divergences
       WHERE realm_id = ${input.realmId} AND quickbooks_payment_id = ${input.quickBooksPaymentId}`)
    return flagged.length > 0
  },
})
