import type BetterSqlite3 from 'better-sqlite3'

export interface StaffUser {
  userId: number
}

export interface StaffUserDirectory {
  /**
   * The active staff user for an address, or null. Resolves the way password
   * reset does -- a verified, non-invalidated address on an active user -- so
   * magic-link sign-in reaches exactly the accounts password sign-in and reset
   * already do, and no others.
   */
  findByEmail(email: string): Promise<StaffUser | null>
}

interface UserRow {
  userId: number
}

// Mirrors the resolution password reset uses (packages/db password-auth):
// a VERIFIED, non-invalidated address on an active user.
//
// The verified check is the whole security of this path (#730). Delivery to an
// address proves control of that address, not that the address belongs to the
// account it hangs off: anyone who can add a pending address to a user could
// otherwise have a link minting that user's session mailed to themselves. An
// unverified row is a claim; only verification settles it. Password reset,
// OIDC linking and Cloudflare Access all require it, and this used to be the
// one sign-in path that did not.
const lookup = `SELECT user.id AS userId
  FROM user_emails email
  JOIN users user ON user.id = email.user_id
  WHERE lower(email.address) = lower(?)
    AND email.invalidated_at IS NULL
    AND email.verified_at IS NOT NULL
    AND user.is_active = 1
  ORDER BY email.id
  LIMIT 1`

const staffUser = (row: UserRow | undefined): StaffUser | null => {
  if (row === undefined) return null
  if (!Number.isSafeInteger(row.userId) || row.userId < 1) {
    throw new RangeError('staff user id is invalid')
  }
  return { userId: row.userId }
}

const normalize = (email: string): string => email.normalize('NFC').trim()

export const createContainerStaffUserDirectory = (
  database: BetterSqlite3.Database,
): StaffUserDirectory => ({
  findByEmail: async (email) =>
    staffUser(database.prepare(lookup).get(normalize(email)) as UserRow | undefined),
})

export const createD1StaffUserDirectory = (
  database: D1Database,
): StaffUserDirectory => ({
  findByEmail: async (email) =>
    staffUser(
      (await database.prepare(lookup).bind(normalize(email)).first<UserRow>()) ??
        undefined,
    ),
})
