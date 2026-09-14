import type BetterSqlite3 from 'better-sqlite3'

export interface StaffUser {
  userId: number
}

export interface StaffUserDirectory {
  /**
   * The active staff user for an address, or null. Resolves the same way the
   * password routes do -- a non-invalidated address on an active user,
   * preferring a verified address -- so magic-link sign-in reaches exactly the
   * accounts password sign-in and reset already do, and no others.
   */
  findByEmail(email: string): Promise<StaffUser | null>
}

interface UserRow {
  userId: number
}

// Mirrors the resolution the password service uses (packages/db password-auth):
// an address that has not been invalidated, on an active user, verified address
// first. Delivery to the address is the proof of control, so an unverified but
// present address is still reachable, exactly as a password reset is.
const lookup = `SELECT user.id AS userId
  FROM user_emails email
  JOIN users user ON user.id = email.user_id
  WHERE lower(email.address) = lower(?)
    AND email.invalidated_at IS NULL
    AND user.is_active = 1
  ORDER BY email.verified_at IS NOT NULL DESC, email.id
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
