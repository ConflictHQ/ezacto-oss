import type { InvoiceStateDatabase } from './invoice-state.js'
import { atomicStatements } from './atomic-statements.js'

export type ManagedQuickBooksOutboxAdmission =
  | { readonly kind: 'absent' | 'stale' | 'unavailable' }
  | { readonly kind: 'current'; readonly realmId: string; readonly generation: number; readonly connectedAt: string }

/** Metadata only. The native event's immutable grant identity must match the
 * current accepted grant. Neither credentials nor wall-clock attribution are
 * part of this decision. Pre-upgrade events without a binding remain withheld.
 */
export const readManagedQuickBooksOutboxAdmission = async (database: InvoiceStateDatabase, eventId: string): Promise<ManagedQuickBooksOutboxAdmission> => {
  const result = await atomicStatements(database, [{ text: `SELECT binding.state,binding.generation,binding.grant_id,binding.realm_id,binding.connected_at,
    g.generation AS current_generation,c.realm_id AS current_realm,c.connected_at AS current_connected_at,c.disconnected_at,
    EXISTS(SELECT 1 FROM quickbooks_managed_grants m WHERE m.grant_id=binding.grant_id AND m.realm_id=c.realm_id
      AND m.recorded_at=c.connected_at AND m.accepted_generation=g.generation) AS accepted,
    EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL)) AS importing
    FROM event_outbox event LEFT JOIN quickbooks_outbox_grants binding ON binding.event_id=event.id
    JOIN quickbooks_connection_generation g ON g.singleton=1 LEFT JOIN quickbooks_connections c ON c.id=1
    WHERE event.id=?`, params: [eventId] }])
  const row = result[0]?.[0]
  if (!row || row.state === null || row.importing === 1) return { kind: 'unavailable' }
  if (row.state === 'absent') return { kind: 'absent' }
  if (row.generation !== row.current_generation || row.disconnected_at !== null
    || row.realm_id !== row.current_realm || row.connected_at !== row.current_connected_at) return { kind: 'stale' }
  if (row.state !== 'bound' || row.accepted !== 1 || typeof row.realm_id !== 'string' || typeof row.connected_at !== 'string'
    || typeof row.generation !== 'number' || !Number.isSafeInteger(row.generation) || row.generation < 0) return { kind: 'unavailable' }
  return { kind: 'current', realmId: row.realm_id, connectedAt: row.connected_at, generation: row.generation }
}
