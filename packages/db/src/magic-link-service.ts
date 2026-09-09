// The adapter that makes portal magic-link auth reachable.
//
// Every piece it needs already existed and nothing composed them: the token
// crypto in @ezacto/core, the single-use record store in magic-link-state, the
// routes in @ezacto/api, and the table since 0033. The worker declared an
// optional `portalAuth` branch and nothing ever supplied it, so the routes were
// mounted behind a value no caller could produce.

import {
  createMagicLinkToken,
  verifyMagicLinkToken,
  MAGIC_LINK_TTL_MS,
} from '@ezacto/core'
import type { MagicLinkStore } from './magic-link-state.js'

export interface ContactLookup {
  contactId: number
  clientId: number
  email: string
  firstName: string
  lastName: string | null
}

interface ContactRow {
  contactId: number
  clientId: number
  email: string
  firstName: string
  lastName: string | null
}

export interface MagicLinkServiceDatabase {
  all<Row>(query: { sql: string; params: readonly unknown[] }): Promise<Row[]>
}

export interface MagicLinkServiceOptions {
  database: MagicLinkServiceDatabase
  store: MagicLinkStore
  /** Server-owned HMAC key, at least 32 bytes. */
  signingKey: Uint8Array
  now?: () => Date
}

const MINIMUM_KEY_BYTES = 32

export const createMagicLinkService = ({
  database,
  store,
  signingKey,
  now = () => new Date(),
}: MagicLinkServiceOptions) => {
  if (signingKey.byteLength < MINIMUM_KEY_BYTES) {
    throw new RangeError('magic link signing key must be at least 32 bytes')
  }

  return {
    /**
     * A contact by address, case-insensitively and only where the client is
     * still active.
     *
     * Matching on `lower(email)` because a person typing their own address does
     * not reproduce the casing a record was created with, and being told "no
     * such contact" because you capitalised your surname is indistinguishable
     * from being told you have no account.
     *
     * An archived client's contacts cannot sign in. The portal shows money, and
     * a client we have stopped working with should not keep a door open to it.
     */
    async findContactByEmail(email: string): Promise<ContactLookup | null> {
      const rows = await database.all<ContactRow>({
        sql: `SELECT contact.id AS contactId, contact.client_id AS clientId,
            contact.email AS email, contact.first_name AS firstName,
            contact.last_name AS lastName
          FROM contacts contact
          JOIN clients client ON client.id = contact.client_id
          WHERE lower(contact.email) = lower(?)
            AND contact.email IS NOT NULL
            AND client.is_active = 1
          LIMIT 2`,
        params: [email],
      })
      // Two contacts sharing an address is a data problem, and picking one of
      // them would sign somebody into a client they may not belong to. Refusing
      // is the safe answer and it is visible, which is how it gets fixed.
      if (rows.length !== 1) return null
      return rows[0]!
    },

    async createToken(contact: ContactLookup) {
      // The TTL is the core module's, not a second copy of fifteen minutes
      // written here. Two places naming the same lifetime is how they stop
      // agreeing.
      return createMagicLinkToken(
        {
          contactEmail: contact.email,
          contactId: contact.contactId,
          clientId: contact.clientId,
          ttlMs: MAGIC_LINK_TTL_MS,
        },
        signingKey,
        now().toISOString(),
      )
    },

    async recordToken(input: {
      jti: string
      contactEmail: string
      contactId: number
      clientId: number
      tokenHash: string
      expiresAt: string
    }): Promise<void> {
      await store.create(input)
    },

    /**
     * Verify the signature, then consume the record.
     *
     * Order matters and is not interchangeable. Verifying first means an
     * unsigned or tampered token never reaches the database, so a stream of
     * guesses cannot burn real records; consuming first would let anyone
     * invalidate a link they cannot use by submitting its jti.
     *
     * Single use is enforced by the store rather than here: the check and the
     * consume have to be one statement, or two redemptions of the same link
     * arriving together both pass the check before either writes.
     */
    async verifyAndConsume(token: string) {
      const payload = await verifyMagicLinkToken(token, signingKey, now().toISOString())
      if (payload === null) return null
      return store.consume(payload.jti)
    },
  }
}
