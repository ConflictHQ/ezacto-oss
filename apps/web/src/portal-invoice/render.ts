import { invoiceDocumentMoney } from '@ezacto/core'
import { defaultTheme } from '../theme.js'

/**
 * The page a client reaches from the link in an emailed invoice (issue 936):
 * the invoice read-only, its PDF where one was sent, and a way to pay where
 * the company takes payment online.
 *
 * Standalone, like the estimate page: it shares the stylesheet and nothing of
 * the staff shell, because the person reading it has no session. The link's
 * token is the only credential and appears only in this page's own address and
 * in the one path below that carries it; the page sets no cookie, loads nothing
 * from anywhere else, and the response says `no-referrer` so not even its
 * address leaves with a click on "Pay online".
 *
 * Opening this page records nothing by itself. The small script it loads
 * reports the page as shown, and downloading the PDF is the other thing that
 * counts as a view, so a mail scanner that only fetches the address is not a
 * client reading their invoice.
 */

export interface PortalInvoicePage {
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
  /** Where the invoice can be paid online, when it can. */
  readonly paymentUrl: string | null
  /** Whether the document that was sent can be downloaded. */
  readonly hasDocument: boolean
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

const statusLabel = (page: PortalInvoicePage): string =>
  page.state === 'paid' ? 'Paid' : page.state === 'closed' ? 'Closed' : 'Open'

export const renderPortalInvoicePage = (page: PortalInvoicePage, token: string): string => {
  const money = (cents: number) => escapeHtml(invoiceDocumentMoney(cents, page.currency))
  // Only a web address the provider handed us; anything else is not a link.
  const payable =
    page.state === 'open' &&
    page.dueAmountCents > 0 &&
    page.paymentUrl !== null &&
    /^https:\/\//u.test(page.paymentUrl)
  return `<!doctype html>
<html lang="en" data-ez-theme="${defaultTheme}" data-ez-scheme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <title>Invoice ${escapeHtml(page.number)} — ${escapeHtml(page.companyName)}</title>
  <link rel="stylesheet" href="/assets/ezacto.css">
  <script type="module" src="/assets/portal-invoice.js"></script>
</head>
<body>
  <main class="portal-invoice" data-portal-invoice>
    <header>
      <p class="eyebrow">${escapeHtml(page.companyName)}</p>
      <h1 id="portal-invoice-heading">Invoice ${escapeHtml(page.number)}</h1>
      ${page.subject === null ? '' : `<p>${escapeHtml(page.subject)}</p>`}
    </header>
    <dl class="recurring-facts" aria-labelledby="portal-invoice-heading">
      <div><dt>Billed to</dt><dd>${escapeHtml(page.clientName)}</dd></div>
      <div><dt>Issued</dt><dd>${escapeHtml(page.issueDate)}</dd></div>
      <div><dt>Due</dt><dd>${escapeHtml(page.dueDate)}</dd></div>
      <div><dt>Status</dt><dd>${statusLabel(page)}</dd></div>
      <div><dt>Amount</dt><dd>${money(page.amountCents)}</dd></div>
      <div><dt>Amount due</dt><dd>${money(page.dueAmountCents)}</dd></div>
    </dl>
    <div class="portal-invoice-actions">
      ${
        page.hasDocument
          ? `<a class="primary-action" href="/portal/invoices/${escapeHtml(token)}/document" data-portal-invoice-document>Download PDF</a>`
          : ''
      }
      ${
        payable
          ? `<a class="primary-action" href="${escapeHtml(page.paymentUrl!)}" rel="noopener noreferrer" data-portal-invoice-pay>Pay online</a>`
          : ''
      }
    </div>
    <p class="hint">${escapeHtml(page.companyName)} is told when this invoice is first opened.</p>
  </main>
</body>
</html>`
}
