import {
  staffInvoiceAmount,
  type StaffInvoiceReport,
  type AdvanceCreditReport,
  type StaffPaymentRow,
} from '@ezacto/core'

export interface PaymentFinancialSources {
  invoices: StaffInvoiceReport[]
  advances: AdvanceCreditReport | null
}
export interface FinancialSection {
  id: string
  title: string
  note: string
  columns: string[]
  rows: Record<string, string | number | null>[]
}
/** Source amounts remain independent currencies and record levels. Invoice
 * amounts describe existing earnings; credit applications are already paid in
 * the monthly ledger. Neither creates an additional obligation or payment. */
export const paymentFinancialSections = (
  sources: PaymentFinancialSources,
  filters: { person: string; currency: string; status: string },
  eligible: StaffPaymentRow[],
): FinancialSection[] => {
  const matches = (name: string, currency: string) =>
    name.toLowerCase().includes(filters.person.trim().toLowerCase()) &&
    (!filters.currency.trim() || currency === filters.currency.trim().toUpperCase())
  const monthMatches = (user: number, month: string) =>
    filters.status === 'all' || eligible.some((row) => row.user_id === user && row.month === month)
  const invoices: FinancialSection = {
    id: 'invoices',
    title: 'Contractor invoices',
    note: 'Current invoice versions only. Received amounts describe the same recorded earnings, not additional obligations. Draft and void invoices contribute no received amount. Open Invoices to inspect immutable version history.',
    columns: [
      'Person',
      'Work month',
      'Currency',
      'Invoice reference',
      'Invoice ID',
      'Invoice version',
      'Status',
      'Amount cents',
      'Received cents',
      'Matched cents',
      'Flags',
    ],
    rows: [],
  }
  const lines: FinancialSection = {
    id: 'invoice-lines',
    title: 'Contractor invoice lines',
    note: 'Lines are the detail of the invoice totals, not additional amounts. Project and entry IDs are explicit source links; no split is inferred.',
    columns: [
      'Person',
      'Work month',
      'Currency',
      'Invoice reference',
      'Invoice ID',
      'Invoice line',
      'Project ID',
      'Entry ID',
      'Selected seconds',
      'Rate cents',
      'Amount cents',
      'Description',
      'Flags',
    ],
    rows: [],
  }
  for (const report of sources.invoices)
    for (const person of report.people)
      for (const invoice of person.invoices) {
        const version = invoice.versions.at(-1)
        if (
          !version ||
          !matches(person.name, version.currency) ||
          !monthMatches(person.user_id, version.month)
        )
          continue
        const base = {
          Person: person.name,
          'Work month': version.month,
          Currency: version.currency,
          'User ID': person.user_id,
          'Invoice ID': invoice.id,
          'Invoice reference': invoice.reference,
          'Invoice version': version.version,
          Status: version.kind,
        }
        invoices.rows.push({
          ...base,
          'Amount cents': version.amount_cents,
          'Received cents': version.kind === 'received' ? version.amount_cents : 0,
          'Matched cents': version.kind === 'received' ? invoice.matched_cents : 0,
          Flags: invoice.flags.join('; '),
        })
        version.lines.forEach((line, index) =>
          lines.rows.push({
            ...base,
            'Invoice line': index + 1,
            'Project ID': line.project_id,
            'Entry ID': line.entry_id,
            'Selected seconds': line.seconds,
            'Rate cents': line.rate_cents,
            'Amount cents': staffInvoiceAmount([line]),
            Description: line.description,
            Flags: (invoice.line_flags[index] ?? []).join('; '),
          }),
        )
      }
  const advances: FinancialSection = {
    id: 'credits',
    title: 'Advance credit statement',
    note: `Credit movement by recorded date: ${sources.advances?.from ?? ''} through ${sources.advances?.to ?? ''}. Opening + settled − net applications − returns = closing. Applications already reduce monthly payable balances: do not add them to paid again. Current available and reserved credit show the latest transfer state, rather than the historical closing balance.`,
    columns: [
      'Person',
      'Currency',
      'From date',
      'To date',
      'Advance item ID',
      'Status',
      'Opening credit cents',
      'Credit settled cents',
      'Credit applied cents',
      'Credit returned cents',
      'Closing credit cents',
      'Current available credit cents',
      'Reserved cents',
    ],
    rows: [],
  }
  const applications: FinancialSection = {
    id: 'credit-applications',
    title: 'Credit applied to earnings',
    note: 'Applications for selected work months, plus applications or reversals recorded in the statement period. Current reversal status is shown. These are the detail of credit use, not new payments. Reversed applications do not contribute to currently applied credit; their historical movement remains in the credit statement.',
    columns: [
      'Person',
      'Work month',
      'Currency',
      'Advance item ID',
      'Application ID',
      'Project ID',
      'Entry ID',
      'Amount cents',
      'Status',
      'Recorded at',
      'Reversed at',
      'Period movement cents',
      'Reason',
    ],
    rows: [],
  }
  const returns: FinancialSection = {
    id: 'credit-returns',
    title: 'Returned advance credit',
    note: 'Returns recorded in the statement period are already deducted from closing credit. They are not payments against contractor earnings.',
    columns: [
      'Person',
      'Currency',
      'Advance item ID',
      'Return ID',
      'Amount cents',
      'Transfer reference',
      'Recorded at',
      'Reason',
    ],
    rows: [],
  }
  for (const credit of sources.advances?.advances ?? []) {
    if (!matches(credit.name, credit.currency)) continue
    const inPeriod = (stamp: string | null) =>
      Boolean(
        stamp &&
        sources.advances &&
        stamp.slice(0, 10) >= sources.advances.from &&
        stamp.slice(0, 10) <= sources.advances.to,
      )
    const relevant = credit.applications.filter(
      (app) =>
        Boolean(
          sources.advances &&
          ((app.month >= sources.advances.from.slice(0, 7) &&
            app.month <= sources.advances.to.slice(0, 7)) ||
            inPeriod(app.recorded_at) ||
            inPeriod(app.reversed_at)),
        ) && monthMatches(credit.user_id, app.month),
    )
    const statusMatches =
      filters.status === 'all' ||
      (filters.status === 'outstanding'
        ? !['paid', 'cancelled', 'failed', 'draft'].includes(credit.state)
        : filters.status === 'processing'
          ? ['creating', 'funding', 'processing'].includes(credit.state)
          : credit.state === filters.status)
    const hasActivity =
      credit.opening_cents !== 0 ||
      credit.period_settled_cents !== 0 ||
      credit.period_applied_cents !== 0 ||
      credit.period_returned_cents !== 0 ||
      credit.closing_cents !== 0 ||
      credit.reserved_cents !== 0 ||
      credit.available_cents !== 0
    const base = {
      Person: credit.name,
      Currency: credit.currency,
      'User ID': credit.user_id,
      'Advance item ID': credit.advance_item_id,
    }
    if (statusMatches && hasActivity)
      advances.rows.push({
        ...base,
        Status: credit.state,
        'From date': sources.advances!.from,
        'To date': sources.advances!.to,
        'Opening credit cents': credit.opening_cents,
        'Credit settled cents': credit.period_settled_cents,
        'Credit applied cents': credit.period_applied_cents,
        'Credit returned cents': credit.period_returned_cents,
        'Closing credit cents': credit.closing_cents,
        'Current available credit cents': credit.available_cents,
        'Reserved cents': credit.reserved_cents,
      })
    if (statusMatches)
      for (const returned of credit.returns.filter((item) => inPeriod(item.recorded_at)))
        returns.rows.push({
          ...base,
          'Return ID': returned.id,
          'Amount cents': returned.amount_cents,
          'Transfer reference': returned.reference,
          'Recorded at': returned.recorded_at,
          Reason: returned.reason,
        })
    for (const app of relevant)
      applications.rows.push({
        ...base,
        'Work month': app.month,
        'Application ID': app.id,
        'Project ID': app.project_id,
        'Entry ID': app.entry_id,
        'Amount cents': app.amount_cents,
        Status: app.reversed_at ? 'Reversed' : 'Applied',
        'Recorded at': app.recorded_at,
        'Reversed at': app.reversed_at,
        'Period movement cents':
          (inPeriod(app.recorded_at) ? app.amount_cents : 0) -
          (inPeriod(app.reversed_at) ? app.amount_cents : 0),
        Reason: app.reason,
      })
  }
  return [invoices, lines, advances, applications, returns]
}
