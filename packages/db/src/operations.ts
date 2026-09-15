import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  clients,
  contacts,
  organizationOwner,
  organizations,
  userBillableRates,
  userCostRates,
  userEmails,
  users,
} from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type RateKind = 'billable' | 'cost'

export type PaymentTerms = 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'

export type InvoiceRecipientStatus = 'none' | 'recipient' | 'cc' | 'bcc'

export interface NewClient {
  harvestId?: number
  name: string
  address?: string | null
  currency?: string
  isActive?: boolean
  parentClientId?: number | null
  billToClientId?: number | null
  paymentTerms?: PaymentTerms
  defaultTaxPct?: number | null
  defaultTax2Pct?: number | null
  defaultDiscountPct?: number | null
  createdAt: string
  updatedAt: string
}

export interface ClientChanges {
  name?: string
  address?: string | null
  currency?: string
  isActive?: boolean
  parentClientId?: number | null
  billToClientId?: number | null
  paymentTerms?: PaymentTerms
  defaultTaxPct?: number | null
  defaultTax2Pct?: number | null
  defaultDiscountPct?: number | null
  updatedAt: string
}

export interface NewContact {
  harvestId?: number
  clientId: number
  title?: string | null
  firstName: string
  lastName?: string | null
  email?: string | null
  phoneOffice?: string | null
  phoneMobile?: string | null
  fax?: string | null
  invoiceRecipientStatus?: InvoiceRecipientStatus
  createdAt: string
  updatedAt: string
}

export interface ClientHierarchyNode {
  ancestorId: number
  descendantId: number
  depth: number
}

export type Client = Omit<typeof clients.$inferSelect, 'statementKey'>

const safeClientColumns = {
  id: clients.id,
  harvestId: clients.harvestId,
  name: clients.name,
  address: clients.address,
  currency: clients.currency,
  isActive: clients.isActive,
  parentClientId: clients.parentClientId,
  billToClientId: clients.billToClientId,
  paymentTerms: clients.paymentTerms,
  defaultTaxPct: clients.defaultTaxPct,
  defaultTax2Pct: clients.defaultTax2Pct,
  defaultDiscountPct: clients.defaultDiscountPct,
  createdAt: clients.createdAt,
  updatedAt: clients.updatedAt,
}

type ReturningQuery<TColumns, TResult> = {
  returning(columns: TColumns): PromiseLike<TResult[]>
}

const rejectStatementKeyInput = (input: object): void => {
  if (
    Object.prototype.hasOwnProperty.call(input, 'statementKey') ||
    Object.prototype.hasOwnProperty.call(input, 'statement_key')
  ) {
    throw new Error('client statement key is server-generated')
  }
}

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

/**
 * A person's own timezone, for the self-service control that sets it. The column
 * default is 'UTC', which means "never set" rather than "chose UTC" -- callers
 * that need the effective zone must still fall back to the organization's.
 */
export const readUserTimezone = async (
  database: Database,
  userId: number,
): Promise<string | null> => {
  const [row] = await database
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.timezone ?? null
}

export const updateUserTimezone = async (
  database: Database,
  userId: number,
  timezone: string,
  updatedAt: string,
): Promise<void> => {
  await database
    .update(users)
    .set({ timezone, updatedAt })
    .where(eq(users.id, userId))
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

export const createClient = async (
  database: Database,
  input: NewClient,
): Promise<Client> => {
  rejectStatementKeyInput(input)
  const [organization] = await database
    .select()
    .from(organizations)
    .where(eq(organizations.id, 1))
    .limit(1)
  if (!organization) throw new Error('organization must exist before creating a client')

  const query = database
    .insert(clients)
    .values({
      harvestId: input.harvestId ?? null,
      name: input.name,
      address: input.address ?? null,
      currency: input.currency ?? organization.currency,
      isActive: input.isActive ?? true,
      parentClientId: input.parentClientId ?? null,
      billToClientId: input.billToClientId ?? null,
      paymentTerms: input.paymentTerms ?? 'custom',
      defaultTaxPct: input.defaultTaxPct ?? null,
      defaultTax2Pct: input.defaultTax2Pct ?? null,
      defaultDiscountPct: input.defaultDiscountPct ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
  const [created] = await (
    query as unknown as ReturningQuery<typeof safeClientColumns, Client>
  ).returning(safeClientColumns)
  if (!created) throw new Error('client creation did not return a row')
  return created
}

type MutableClientValues = Partial<
  Pick<
    typeof clients.$inferInsert,
    | 'name'
    | 'address'
    | 'currency'
    | 'isActive'
    | 'parentClientId'
    | 'billToClientId'
    | 'paymentTerms'
    | 'defaultTaxPct'
    | 'defaultTax2Pct'
    | 'defaultDiscountPct'
  >
> & { updatedAt: string }

export const updateClient = async (
  database: Database,
  clientId: number,
  input: ClientChanges,
): Promise<Client> => {
  // Reparenting is deliberately single-row. To reverse an existing edge, detach
  // it first and then attach the replacement so storage never observes a cycle.
  rejectStatementKeyInput(input)
  const values: MutableClientValues = { updatedAt: input.updatedAt }
  if (input.name !== undefined) values.name = input.name
  if (input.address !== undefined) values.address = input.address
  if (input.currency !== undefined) values.currency = input.currency
  if (input.isActive !== undefined) values.isActive = input.isActive
  if (input.parentClientId !== undefined) values.parentClientId = input.parentClientId
  if (input.billToClientId !== undefined) values.billToClientId = input.billToClientId
  if (input.paymentTerms !== undefined) values.paymentTerms = input.paymentTerms
  if (input.defaultTaxPct !== undefined) values.defaultTaxPct = input.defaultTaxPct
  if (input.defaultTax2Pct !== undefined) values.defaultTax2Pct = input.defaultTax2Pct
  if (input.defaultDiscountPct !== undefined) {
    values.defaultDiscountPct = input.defaultDiscountPct
  }

  const query = database
    .update(clients)
    .set(values)
    .where(eq(clients.id, clientId))
  const [updated] = await (
    query as unknown as ReturningQuery<typeof safeClientColumns, Client>
  ).returning(safeClientColumns)
  if (!updated) throw new Error('client not found')
  return updated
}

export const rotateClientStatementKey = async (
  database: Database,
  clientId: number,
  updatedAt: string,
): Promise<string> => {
  const query = database
    .update(clients)
    .set({ statementKey: sql`lower(hex(randomblob(32)))`, updatedAt })
    .where(eq(clients.id, clientId))
  const statementKeyColumn = { statementKey: clients.statementKey }
  const [updated] = await (
    query as unknown as ReturningQuery<typeof statementKeyColumn, { statementKey: string }>
  ).returning(statementKeyColumn)
  if (!updated) throw new Error('client not found')
  return updated.statementKey
}

export const createContact = async (
  database: Database,
  input: NewContact,
): Promise<typeof contacts.$inferSelect> => {
  const [created] = await database
    .insert(contacts)
    .values({
      harvestId: input.harvestId ?? null,
      clientId: input.clientId,
      title: input.title ?? null,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      phoneOffice: input.phoneOffice ?? null,
      phoneMobile: input.phoneMobile ?? null,
      fax: input.fax ?? null,
      invoiceRecipientStatus: input.invoiceRecipientStatus ?? 'none',
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning()
  if (!created) throw new Error('contact creation did not return a row')
  return created
}

export const reassignContact = async (
  database: Database,
  contactId: number,
  clientId: number,
  updatedAt: string,
): Promise<typeof contacts.$inferSelect> => {
  const [updated] = await database
    .update(contacts)
    .set({ clientId, updatedAt })
    .where(eq(contacts.id, contactId))
    .returning()
  if (!updated) throw new Error('contact not found')
  return updated
}

export const listClientDescendants = async (
  database: Database,
  clientId: number,
): Promise<ClientHierarchyNode[]> => {
  const rows = await database.all<{
    ancestor_id: number
    descendant_id: number
    depth: number
  }>(sql`
    WITH RECURSIVE hierarchy(ancestor_id, descendant_id, depth, visited) AS (
      SELECT id, id, 0, printf(',%d,', id) FROM clients WHERE id = ${clientId}
      UNION ALL
      SELECT hierarchy.ancestor_id, child.id, hierarchy.depth + 1,
        hierarchy.visited || child.id || ','
      FROM hierarchy
      JOIN clients child ON child.parent_client_id = hierarchy.descendant_id
      WHERE instr(hierarchy.visited, printf(',%d,', child.id)) = 0
    )
    SELECT ancestor_id, descendant_id, depth FROM hierarchy ORDER BY depth, descendant_id
  `)
  return rows.map((row) => ({
    ancestorId: row.ancestor_id,
    descendantId: row.descendant_id,
    depth: row.depth,
  }))
}

export const listClientAncestors = async (
  database: Database,
  clientId: number,
): Promise<ClientHierarchyNode[]> => {
  const rows = await database.all<{
    ancestor_id: number
    descendant_id: number
    depth: number
  }>(sql`
    WITH RECURSIVE ancestors(ancestor_id, descendant_id, depth) AS (
      SELECT id, id, 0 FROM clients WHERE id = ${clientId}
      UNION ALL
      SELECT parent.id, ancestors.descendant_id, ancestors.depth + 1
      FROM ancestors
      JOIN clients child ON child.id = ancestors.ancestor_id
      JOIN clients parent ON parent.id = child.parent_client_id
      WHERE child.parent_client_id IS NOT NULL
    )
    SELECT ancestor_id, descendant_id, depth FROM ancestors ORDER BY depth
  `)
  return rows.map((row) => ({
    ancestorId: row.ancestor_id,
    descendantId: row.descendant_id,
    depth: row.depth,
  }))
}
