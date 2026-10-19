import { sql } from 'drizzle-orm'
import { executeInvoiceLifecycleCommand, type InvoiceStateDatabase } from './invoice-state.js'

/**
 * Invoice view receipts (issue 936): the hosted invoice page a client reaches
 * from the emailed link, and the record that they looked.
 *
 * The token in the link is a bearer secret. It is 256 random bits, shown once
 * in the email, and stored only as a SHA-256, so neither a copy of the database
 * nor a log line can open an invoice. Every way a lookup can fail -- a token
 * of the wrong shape, one nobody was ever sent, one that has expired, one whose
 * invoice has gone back to draft -- is the same `null`, so nothing here tells a
 * guesser which of those it was.
 *
 * A view is recorded by the invoice.view command as the system, which writes
 * the `view` row into the invoice's history and emits invoice.viewed. It is
 * idempotent per link: the first view runs the command, every later one only
 * moves the link's last-viewed time.
 */

/** Days a link stays valid after the send it came with. */
export const VIEW_LINK_LIFETIME_DAYS = 180

/** Lookups one caller may make in a minute before the public routes refuse. */
export const VIEW_LINK_REQUESTS_PER_MINUTE = 60

/** 32 random bytes, base64url without padding. */
export const viewLinkTokenPattern = /^[A-Za-z0-9_-]{43}$/u

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const digestHex = async (value: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))

/** A fresh, unguessable token. */
export const mintViewLinkToken = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)))

/** What is stored in place of a token. */
export const hashViewLinkToken = (token: string): Promise<string> => digestHex(token)

/** Equal-length comparison that does not stop at the first difference. */
export const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

export const viewLinkExpiry = (sentAt: string): string =>
  new Date(Date.parse(sentAt) + VIEW_LINK_LIFETIME_DAYS * 86_400_000).toISOString()

/** The company setting. Off until somebody turns it on. */
export const readViewReceiptsEnabled = async (database: InvoiceStateDatabase): Promise<boolean> => {
  const rows = await database.all<{ enabled: number }>(
    sql`SELECT invoice_view_receipts AS enabled FROM organizations ORDER BY id LIMIT 1`,
  )
  return rows[0]?.enabled === 1
}

export interface InvoiceViewPage {
  readonly linkId: number
  readonly invoiceId: number
  readonly invoiceMessageId: number
  readonly firstViewedAt: string | null
  readonly companyName: string
  readonly clientName: string
  readonly number: string
  readonly subject: string | null
  readonly currency: string
  readonly issueDate: string
  readonly dueDate: string
  readonly amountCents: number
  readonly dueAmountCents: number
  readonly state: 'open' | 'paid' | 'closed'
}

interface PageRow extends Omit<InvoiceViewPage, 'state'> {
  tokenHash: string
  expiresAt: string
  state: string
}

/**
 * The page a token opens, or `null` for anything that is not a live link to an
 * invoice that has been sent. Reads only; looking is not viewing.
 */
export const readInvoiceViewPage = async (
  database: InvoiceStateDatabase,
  token: string,
  now: string,
): Promise<InvoiceViewPage | null> => {
  if (!viewLinkTokenPattern.test(token)) return null
  const tokenHash = await hashViewLinkToken(token)
  const rows = await database.all<PageRow>(
    sql`SELECT link.id AS linkId, link.invoice_id AS invoiceId,
               link.invoice_message_id AS invoiceMessageId,
               link.first_viewed_at AS firstViewedAt, link.token_hash AS tokenHash,
               link.expires_at AS expiresAt,
               organization.name AS companyName, client.name AS clientName,
               invoice.number AS number, invoice.subject AS subject,
               invoice.currency AS currency, invoice.issue_date AS issueDate,
               invoice.due_date AS dueDate, invoice.amount_cents AS amountCents,
               invoice.due_amount_cents AS dueAmountCents, invoice.state AS state
        FROM invoice_view_links link
        JOIN invoices invoice ON invoice.id = link.invoice_id
        JOIN clients client ON client.id = invoice.client_id
        CROSS JOIN (SELECT name FROM organizations ORDER BY id LIMIT 1) organization
        WHERE link.token_hash = ${tokenHash}`,
  )
  const row = rows[0]
  if (row === undefined) return null
  if (!constantTimeEqual(row.tokenHash, tokenHash)) return null
  if (!(Date.parse(row.expiresAt) > Date.parse(now))) return null
  // A draft is not something a client has been billed for, and the view
  // command refuses it; so does the page.
  if (row.state !== 'open' && row.state !== 'paid' && row.state !== 'closed') return null
  return {
    linkId: row.linkId,
    invoiceId: row.invoiceId,
    invoiceMessageId: row.invoiceMessageId,
    firstViewedAt: row.firstViewedAt,
    companyName: row.companyName,
    clientName: row.clientName,
    number: row.number,
    subject: row.subject,
    currency: row.currency,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    amountCents: row.amountCents,
    dueAmountCents: row.dueAmountCents,
    state: row.state,
  }
}

/**
 * Counts one request against the caller's minute. `false` once they are over,
 * and the caller is refused until the minute turns. The key is hashed, so the
 * table never holds an address.
 */
export const allowViewLinkRequest = async (
  database: InvoiceStateDatabase,
  clientKey: string,
  now: string,
): Promise<boolean> => {
  const window = Math.floor(Date.parse(now) / 60_000)
  const client = await digestHex(`invoice-view-limit\u001f${clientKey}`)
  const rows = await database.all<{ attempts: number }>(
    sql`INSERT INTO invoice_view_limits (window_minute, client_hash, attempts)
        VALUES (${window}, ${client}, 1)
        ON CONFLICT (window_minute, client_hash)
        DO UPDATE SET attempts = min(attempts + 1, ${VIEW_LINK_REQUESTS_PER_MINUTE + 1})
        RETURNING attempts`,
  )
  await database.run(sql`DELETE FROM invoice_view_limits WHERE window_minute < ${window - 2}`)
  return (rows[0]?.attempts ?? VIEW_LINK_REQUESTS_PER_MINUTE + 1) <= VIEW_LINK_REQUESTS_PER_MINUTE
}

const stableDigest = async (...parts: readonly (string | number)[]): Promise<string> =>
  digestHex(parts.join('\u001f'))

/**
 * Records that the page behind this link was looked at: the first time, the
 * invoice.view command; every time, the link's own last-viewed bookkeeping.
 * `false` when the invoice can no longer be viewed.
 */
export const recordInvoiceView = async (
  database: InvoiceStateDatabase,
  page: InvoiceViewPage,
  now: string,
): Promise<boolean> => {
  let viewMessageId: number | null = null
  if (page.firstViewedAt === null) {
    const commandId = `invoice-view-link-${String(page.linkId)}`
    const digest = await stableDigest('invoice-view', page.invoiceId, commandId)
    viewMessageId = Number.parseInt(digest.slice(0, 13), 16) + 1
    const sent = (
      await database.all<{ recipients: string; cc: string | null; createdAt: string }>(
        sql`SELECT recipients, cc_recipients AS cc, created_at AS createdAt
            FROM invoice_messages WHERE id = ${page.invoiceMessageId}`,
      )
    )[0]
    const people = (stored: string | null) => {
      try {
        const parsed: unknown = JSON.parse(stored ?? '[]')
        return Array.isArray(parsed)
          ? parsed.filter(
              (entry): entry is { name: string; email: string } =>
                typeof entry === 'object' &&
                entry !== null &&
                typeof (entry as { name?: unknown }).name === 'string' &&
                typeof (entry as { email?: unknown }).email === 'string',
            )
          : []
      } catch {
        return []
      }
    }
    try {
      await executeInvoiceLifecycleCommand(database, {
        invoiceId: page.invoiceId,
        commandId,
        command: 'view',
        actor: { type: 'system', id: null },
        occurredAt: now,
        messageId: viewMessageId,
        eventId: `evt_${digest}`,
        message: {
          sentBy: null,
          sentByEmail: null,
          sentFrom: null,
          sentFromEmail: null,
          // The same people the email went to: a receipt is per send, so this
          // says whose email it was, not who opened it.
          recipients: people(sent?.recipients ?? null),
          cc: people(sent?.cc ?? null),
          subject: null,
          body: `First opened from the email sent on ${(sent?.createdAt ?? now).slice(0, 10)}.`,
          attachPdf: false,
          sendMeACopy: false,
          thankYou: false,
          reminder: false,
          sendReminderOn: null,
        },
        authorize: async (actor) => actor.type === 'system',
      })
    } catch {
      // The invoice moved out of a viewable state between the read and now.
      return false
    }
  }
  await database.run(
    sql`UPDATE invoice_view_links
        SET first_viewed_at = COALESCE(first_viewed_at, ${now}), last_viewed_at = ${now},
            view_count = view_count + 1,
            view_message_id = COALESCE(view_message_id, ${viewMessageId})
        WHERE id = ${page.linkId}`,
  )
  return true
}

/** When the link a message carried was first opened, per message id. */
export const readViewReceipts = async (
  database: InvoiceStateDatabase,
  invoiceMessageIds: readonly number[],
): Promise<ReadonlyMap<number, string>> => {
  if (invoiceMessageIds.length === 0) return new Map()
  const rows = await database.all<{ messageId: number; viewedAt: string }>(
    sql`SELECT invoice_message_id AS messageId, first_viewed_at AS viewedAt
        FROM invoice_view_links
        WHERE first_viewed_at IS NOT NULL
          AND invoice_message_id IN (${sql.join(
            invoiceMessageIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
  )
  return new Map(rows.map(({ messageId, viewedAt }) => [messageId, viewedAt]))
}

/**
 * The origin a deployment's links point at, from its configured base URL, or
 * `null` where there is none worth linking to: not a URL, carries credentials,
 * or is plain http anywhere but a developer's own machine. Read from
 * configuration and never from a request, so a caller cannot choose where a
 * client's emailed link goes.
 */
export const invoiceViewLinkOrigin = (configured: string | undefined): string | null => {
  if (configured === undefined || configured.trim() === '') return null
  let url: URL
  try {
    url = new URL(configured.trim())
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  return url.origin
}

/** The path a link's page is served at, under the origin the deployment is reached on. */
export const invoiceViewLinkUrl = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/u, '')}/portal/invoices/${token}`

/**
 * What the send route needs to carry a link in an invoice email: whether the
 * company has asked for one, a fresh link for a send, and the stand-in the
 * preview shows. A preview mints nothing -- its stand-in is not a token and
 * opens nothing.
 */
export interface InvoiceViewLinkIssuer {
  enabled(): Promise<boolean>
  previewUrl: string
  mint(sentAt: string): Promise<{ url: string; tokenHash: string; expiresAt: string }>
}

export const createInvoiceViewLinkIssuer = (
  database: InvoiceStateDatabase,
  origin: string,
): InvoiceViewLinkIssuer => ({
  enabled: () => readViewReceiptsEnabled(database),
  previewUrl: invoiceViewLinkUrl(origin, 'a-link-is-created-when-the-invoice-is-sent'),
  mint: async (sentAt) => {
    const token = mintViewLinkToken()
    return {
      url: invoiceViewLinkUrl(origin, token),
      tokenHash: await hashViewLinkToken(token),
      expiresAt: viewLinkExpiry(sentAt),
    }
  },
})
