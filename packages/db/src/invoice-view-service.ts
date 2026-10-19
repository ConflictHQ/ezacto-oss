import { readAttachedDocument } from './invoice-documents.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import {
  allowViewLinkRequest,
  readInvoiceViewPage,
  recordInvoiceView,
  type InvoiceViewPage,
} from './invoice-view-links.js'

/** What the hosted page shows, and whether it has a document and a way to pay. */
export interface InvoiceViewPageData
  extends Omit<InvoiceViewPage, 'linkId' | 'invoiceId' | 'invoiceMessageId' | 'firstViewedAt'> {
  readonly paymentUrl: string | null
  readonly hasDocument: boolean
}

/**
 * The public side of the hosted page, as the routes use it. Every method takes
 * the token the caller presented and answers `null` or `false` for anything
 * that is not a live link, without saying which of the many reasons it was.
 */
export interface InvoiceViewService {
  allow(clientKey: string, now: string): Promise<boolean>
  /** The page behind a token. Looking is not viewing: this records nothing. */
  open(token: string, now: string): Promise<InvoiceViewPageData | null>
  /** The page was shown to a person: record the view. */
  shown(token: string, now: string): Promise<boolean>
  /** The document that was sent, and the view that downloading it is. */
  download(token: string, now: string): Promise<{ filename: string; bytes: Uint8Array } | null>
}

export const createInvoiceViewService = (options: {
  readonly database: InvoiceStateDatabase
  /** Where the invoice can be paid, when it can; absent where nothing takes payment. */
  readonly paymentUrl?: (invoiceId: number) => Promise<string | null>
  /** The stored bytes of a sent document; absent where the deployment keeps none. */
  readonly readDocument?: (objectKey: string) => Promise<Uint8Array | null>
}): InvoiceViewService => {
  const { database } = options
  const sentDocument = async (page: InvoiceViewPage) =>
    options.readDocument === undefined
      ? null
      : await readAttachedDocument(database, page.invoiceMessageId)
  return {
    allow: (clientKey, now) => allowViewLinkRequest(database, clientKey, now),
    async open(token, now) {
      const page = await readInvoiceViewPage(database, token, now)
      if (page === null) return null
      const shown = {
        companyName: page.companyName,
        clientName: page.clientName,
        number: page.number,
        subject: page.subject,
        currency: page.currency,
        issueDate: page.issueDate,
        dueDate: page.dueDate,
        amountCents: page.amountCents,
        dueAmountCents: page.dueAmountCents,
        state: page.state,
      }
      const paymentUrl =
        options.paymentUrl === undefined || page.state !== 'open' || page.dueAmountCents <= 0
          ? null
          : await options.paymentUrl(page.invoiceId).catch(() => null)
      return { ...shown, paymentUrl, hasDocument: (await sentDocument(page)) !== null }
    },
    async shown(token, now) {
      const page = await readInvoiceViewPage(database, token, now)
      return page === null ? false : recordInvoiceView(database, page, now)
    },
    async download(token, now) {
      const page = await readInvoiceViewPage(database, token, now)
      if (page === null) return null
      const stored = await sentDocument(page)
      if (stored === null) return null
      const bytes = await options.readDocument!(stored.objectKey)
      if (bytes === null) return null
      // Downloading the document is looking at the invoice. A view that cannot
      // be recorded (it moved out of a viewable state in the meantime) still
      // gets the document it was sent: the record is ours, not the client's.
      await recordInvoiceView(database, page, now)
      return { filename: stored.filename, bytes }
    },
  }
}
