import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * What an invoice carries beyond itself, and who decided (issue 647).
 *
 * Three booleans had accumulated, each a nullable column on `invoices` paired
 * with a NOT NULL default on `organizations`, and each cost a migration, a
 * store triple, two route fields, two contract fields and a branch in both
 * runtimes. Migration 0056 named the threshold: four of those is a list wearing
 * a disguise. This is the list.
 *
 * The precedence rule lives here once. An invoice's own answer wins; an invoice
 * that has not answered follows the organization *as it stands when the invoice
 * is sent*, not as it stood when the invoice was raised -- an operator who turns
 * something off today expects that to govern an invoice raised yesterday.
 */

export const invoiceExtraKinds = ['document', 'files', 'thank_you', 'journal'] as const
export type InvoiceExtraKind = (typeof invoiceExtraKinds)[number]

/**
 * `false` is off. `true` is on. The journal answers with a level instead,
 * because it is not a yes/no question -- it renders every entry that was billed
 * or the same hours totalled per project, and a preference that could only say
 * yes would have forced a second column beside it on the day it landed.
 */
export type InvoiceExtraValue = boolean | 'detailed' | 'summary'

export type InvoiceExtras = Partial<Record<InvoiceExtraKind, InvoiceExtraValue>>

const isKind = (value: string): value is InvoiceExtraKind =>
  (invoiceExtraKinds as readonly string[]).includes(value)

const isValue = (value: unknown): value is InvoiceExtraValue =>
  typeof value === 'boolean' || value === 'detailed' || value === 'summary'

/**
 * Reads a stored object, keeping only what this version understands.
 *
 * A row written by a later deployment may carry a kind this one has never heard
 * of. Dropping it is right -- acting on a preference you cannot interpret is
 * worse than ignoring it -- and the vocabulary trigger is what stops anything
 * writing one in the first place.
 */
export const parseInvoiceExtras = (stored: string | null): InvoiceExtras => {
  if (stored === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const extras: InvoiceExtras = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (isKind(key) && isValue(value)) extras[key] = value
  }
  return extras
}

export interface ResolvedInvoiceExtra {
  /** What will actually happen. */
  readonly effective: InvoiceExtraValue
  /** `null` when this invoice has not answered and follows the organization. */
  readonly invoice: InvoiceExtraValue | null
  readonly organization: InvoiceExtraValue
}

/** Off, for every kind, unless something says otherwise. */
const OFF: InvoiceExtraValue = false

export const resolveInvoiceExtra = (
  organization: InvoiceExtras,
  invoice: InvoiceExtras,
  kind: InvoiceExtraKind,
): ResolvedInvoiceExtra => {
  const organizationValue = organization[kind] ?? OFF
  const invoiceValue = invoice[kind]
  return {
    invoice: invoiceValue ?? null,
    organization: organizationValue,
    effective: invoiceValue ?? organizationValue,
  }
}

/** Whether a kind is on at all, for the callers that only need yes or no. */
export const isExtraEnabled = (value: InvoiceExtraValue): boolean => value !== false

const readOrganizationExtras = async (
  database: InvoiceStateDatabase,
): Promise<InvoiceExtras> => {
  const rows = await database.all<{ extras: string | null }>(
    sql`SELECT invoice_extras AS extras FROM organizations ORDER BY id LIMIT 1`,
  )
  return parseInvoiceExtras(rows[0]?.extras ?? null)
}

export const readOrganizationInvoiceExtras = readOrganizationExtras

/** Both answers for one invoice, or `null` when the invoice does not exist. */
export const readInvoiceExtras = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{ invoice: InvoiceExtras; organization: InvoiceExtras } | null> => {
  const rows = await database.all<{ extras: string | null }>(
    sql`SELECT invoice_extras AS extras FROM invoices WHERE id = ${invoiceId}`,
  )
  if (rows[0] === undefined) return null
  return {
    invoice: parseInvoiceExtras(rows[0].extras),
    organization: await readOrganizationExtras(database),
  }
}

/**
 * Resolves one kind for one invoice, which is what every sender actually wants.
 *
 * An unknown invoice is off rather than an error: a sender asking about an
 * invoice that has gone is answered, not thrown at.
 */
export const resolveInvoiceExtraFor = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
  kind: InvoiceExtraKind,
): Promise<ResolvedInvoiceExtra> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) {
    return { effective: OFF, invoice: null, organization: OFF }
  }
  return resolveInvoiceExtra(both.organization, both.invoice, kind)
}

/**
 * Sets one kind on one invoice. `null` hands it back to the organization.
 *
 * Read, merge, write -- the whole object is rewritten, because SQLite's
 * `json_set` cannot remove a key and removal is how "follow the organization"
 * is spelled.
 */
export const setInvoiceExtra = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
  kind: InvoiceExtraKind,
  value: InvoiceExtraValue | null,
): Promise<boolean> => {
  const rows = await database.all<{ extras: string | null }>(
    sql`SELECT invoice_extras AS extras FROM invoices WHERE id = ${invoiceId}`,
  )
  if (rows[0] === undefined) return false
  const extras = parseInvoiceExtras(rows[0].extras)
  if (value === null) delete extras[kind]
  else extras[kind] = value
  const next = Object.keys(extras).length === 0 ? null : JSON.stringify(extras)
  await database.run(
    sql`UPDATE invoices SET invoice_extras = ${next} WHERE id = ${invoiceId}`,
  )
  return true
}

/**
 * Sets one kind on the organization, which is where the answer stops.
 *
 * No `null` here: an invoice can defer, and the organization has nothing to
 * defer to.
 */
export const setOrganizationInvoiceExtra = async (
  database: InvoiceStateDatabase,
  kind: InvoiceExtraKind,
  value: InvoiceExtraValue,
): Promise<void> => {
  const extras = await readOrganizationExtras(database)
  extras[kind] = value
  await database.run(
    sql`UPDATE organizations SET invoice_extras = ${JSON.stringify(extras)}`,
  )
}
