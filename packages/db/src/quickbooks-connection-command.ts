import type { QuickBooksStore } from './quickbooks.js'
/** Shared canonical write, used inside the native grant batch as well as the
 * existing self-hosted OAuth store. No provider call can occur in this helper. */
export const quickBooksConnectionStatements = (
  input: Parameters<QuickBooksStore['saveConnection']>[0],
) => [
  {
    // A new native connection is distinct even when its timestamp/actor/realm
    // happen to equal the live row. Ordinary saveTokens never enters this path.
    // Managed acceptance requires no live row, so its insert still advances once.
    text: `UPDATE quickbooks_connection_generation SET generation=generation+1 WHERE singleton=1
      AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE id=1 AND disconnected_at IS NULL
        AND realm_id=? AND connected_by_user_id=? AND connected_at=?) RETURNING generation`,
    params: [input.realmId, input.connectedByUserId, input.now],
  },
  {
    text: `UPDATE quickbooks_connections SET disconnected_at=?,updated_at=?
      WHERE id=1 AND disconnected_at IS NULL AND realm_id<>? RETURNING id`,
    params: [input.now, input.now, input.realmId],
  },
  {
    text: `INSERT INTO quickbooks_connections(id,realm_id,company_name,access_token,refresh_token,
      access_token_expires_at,refresh_token_expires_at,scope,allow_online_payment,connected_by_user_id,connected_at,disconnected_at,created_at,updated_at)
      VALUES(1,?,?,?,?,?,?,?,0,?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET
      realm_id=excluded.realm_id,company_name=excluded.company_name,access_token=excluded.access_token,refresh_token=excluded.refresh_token,
      access_token_expires_at=excluded.access_token_expires_at,refresh_token_expires_at=excluded.refresh_token_expires_at,
      scope=excluded.scope,connected_by_user_id=excluded.connected_by_user_id,connected_at=excluded.connected_at,disconnected_at=NULL,updated_at=excluded.updated_at RETURNING id`,
    params: [
      input.realmId,
      input.companyName,
      input.accessToken,
      input.refreshToken,
      input.accessTokenExpiresAt,
      input.refreshTokenExpiresAt,
      input.scope,
      input.connectedByUserId,
      input.now,
      input.now,
      input.now,
    ],
  },
]
