import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { organizationOwner, userBillableRates, userCostRates, userEmails } from './schema.js'

type Database = BetterSQLite3Database | DrizzleD1Database
type RateKind = 'billable' | 'cost'

export interface NewRate {
  harvestId?: number
  userId: number
  amountCents: number
  startDate: string | null
  createdAt: string
  updatedAt: string
}

export const appendUserRate = async (
  database: Database,
  kind: RateKind,
  rate: NewRate,
): Promise<void> => {
  const table = kind === 'billable' ? userBillableRates : userCostRates
  await database.insert(table).values(rate)
}

export const verifyUserEmail = async (
  database: Database,
  emailId: number,
  verifiedAt: string,
): Promise<void> => {
  await database
    .update(userEmails)
    .set({ verifiedAt, updatedAt: verifiedAt })
    .where(eq(userEmails.id, emailId))
}

export const transferOrganizationOwnership = async (
  database: Database,
  userId: number,
  updatedAt: string,
): Promise<void> => {
  await database
    .update(organizationOwner)
    .set({ userId, updatedAt })
    .where(eq(organizationOwner.id, 1))
}
