import { parseJournalFormats, type JournalFormat } from '@ezacto/core'
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

export const invoiceExtraKinds = [
  'document',
  'files',
  'thank_you',
  'journal',
  'reminders',
  'journal_formats',
  'append',
] as const
export type InvoiceExtraKind = (typeof invoiceExtraKinds)[number]

/**
 * `false` is off. `true` is on. The journal answers with a level instead,
 * because it is not a yes/no question -- it renders every entry that was billed
 * or the same hours totalled per project, and a preference that could only say
 * yes would have forced a second column beside it on the day it landed.
 *
 * `journal_formats` answers with the files that level goes as (migration
 * 0096): a non-empty set of `pdf`, `csv` and `xlsx`, held in that order.
 */
export type InvoiceExtraValue = boolean | 'detailed' | 'summary' | readonly JournalFormat[]

export type InvoiceExtras = Partial<Record<InvoiceExtraKind, InvoiceExtraValue>>

/**
 * What a client's own rules can say (migration 0099): how its invoices go --
 * the document, the files, whether the files are bound into the document, the
 * hours report and its formats. Whether its invoices are chased or thanked
 * stays the organization's and the invoice's.
 */
export const clientInvoiceExtraKinds = [
  'document',
  'files',
  'journal',
  'journal_formats',
  'append',
] as const satisfies readonly InvoiceExtraKind[]
export type ClientInvoiceExtraKind = (typeof clientInvoiceExtraKinds)[number]

const isKind = (value: string): value is InvoiceExtraKind =>
  (invoiceExtraKinds as readonly string[]).includes(value)

/**
 * A stored value as this version reads it, or `null` when it cannot be read.
 * Per kind, because a format list under `document` is as unreadable as a
 * boolean under `journal_formats`.
 */
const valueFor = (kind: InvoiceExtraKind, value: unknown): InvoiceExtraValue | null => {
  if (kind === 'journal_formats') return parseJournalFormats(value)
  return typeof value === 'boolean' || value === 'detailed' || value === 'summary' ? value : null
}

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
    if (!isKind(key)) continue
    const read = valueFor(key, value)
    if (read !== null) extras[key] = read
  }
  return extras
}

export interface ResolvedInvoiceExtra {
  /** What will actually happen. */
  readonly effective: InvoiceExtraValue
  /** `null` when this invoice has not answered and follows its client. */
  readonly invoice: InvoiceExtraValue | null
  /** `null` when the client has no rule and follows the organization. */
  readonly client: InvoiceExtraValue | null
  readonly organization: InvoiceExtraValue
}

/** Off, for every kind, unless something says otherwise. */
const OFF: InvoiceExtraValue = false

/**
 * An invoice's own answer, else its client's standing rule, else the
 * organization's: the order an operator would give if asked, and the one a
 * Send dialog shows them.
 */
export const resolveInvoiceExtra = (
  organization: InvoiceExtras,
  invoice: InvoiceExtras,
  kind: InvoiceExtraKind,
  client: InvoiceExtras = {},
): ResolvedInvoiceExtra => {
  const organizationValue = organization[kind] ?? OFF
  const clientValue = client[kind]
  const invoiceValue = invoice[kind]
  return {
    invoice: invoiceValue ?? null,
    client: clientValue ?? null,
    organization: organizationValue,
    effective: invoiceValue ?? clientValue ?? organizationValue,
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

/**
 * The three answers for one invoice -- its own, its client's, the
 * organization's -- or `null` when the invoice does not exist.
 */
export const readInvoiceExtras = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{
  invoice: InvoiceExtras
  client: InvoiceExtras
  organization: InvoiceExtras
} | null> => {
  const rows = await database.all<{ extras: string | null; clientId: number }>(
    sql`SELECT invoice_extras AS extras, client_id AS clientId FROM invoices
        WHERE id = ${invoiceId}`,
  )
  if (rows[0] === undefined) return null
  return {
    invoice: parseInvoiceExtras(rows[0].extras),
    client: (await readClientInvoiceExtras(database, rows[0].clientId)) ?? {},
    organization: await readOrganizationExtras(database),
  }
}

/** A client's rules, keeping only the kinds a client can hold. */
const clientOnly = (extras: InvoiceExtras): InvoiceExtras =>
  Object.fromEntries(
    Object.entries(extras).filter(([kind]) =>
      (clientInvoiceExtraKinds as readonly string[]).includes(kind),
    ),
  )

/** A client's rules alone, or `null` when the client does not exist. */
export const readClientInvoiceExtras = async (
  database: InvoiceStateDatabase,
  clientId: number,
): Promise<InvoiceExtras | null> => {
  // `*` rather than the column by name, so a database migration 0099 has not
  // reached yet reads a client with no rules instead of refusing to read one.
  const rows = await database.all<Record<string, unknown>>(
    sql`SELECT * FROM clients WHERE id = ${clientId}`,
  )
  if (rows[0] === undefined) return null
  const stored = rows[0].invoice_extras
  return clientOnly(parseInvoiceExtras(typeof stored === 'string' ? stored : null))
}

/**
 * Replaces a client's rules with exactly these. A kind left out follows the
 * organization; an empty set clears the column, so "no rules" has one
 * spelling.
 */
export const setClientInvoiceExtras = async (
  database: InvoiceStateDatabase,
  clientId: number,
  extras: Partial<Record<ClientInvoiceExtraKind, InvoiceExtraValue>>,
  updatedAt: string,
): Promise<boolean> => {
  const kept = clientOnly(extras)
  const next = Object.keys(kept).length === 0 ? null : JSON.stringify(kept)
  const rows = await database.all<{ id: number }>(
    sql`UPDATE clients SET invoice_extras = ${next}, updated_at = ${updatedAt}
        WHERE id = ${clientId} RETURNING id`,
  )
  return rows.length === 1
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
    return { effective: OFF, invoice: null, client: null, organization: OFF }
  }
  return resolveInvoiceExtra(both.organization, both.invoice, kind, both.client)
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
