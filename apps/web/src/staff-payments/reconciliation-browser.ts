import type { ContractorReview, ContractorReviewPerson, ContractorCurrencyReview, StaffPaymentReport } from '@ezacto/core'
import { renderDataTable } from '../components/data-table.js'
import { moneyText } from '../money-display.js'
import { staffPaymentMoney } from './model.js'
import type { PaymentTab } from './tabs.js'

export interface ContractorReviewApi {
  getContractorReview?(month: string, signal?: AbortSignal): Promise<ContractorReview>
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
  const element = document.createElement(tag)
  let offset = 0
  for (const match of text.matchAll(/\b[A-Z]{3} -?\d[\d,]*\.\d{2}\b/gu)) {
    element.appendChild(document.createTextNode(text.slice(offset, match.index)))
    element.appendChild(moneyText(match[0]))
    offset = match.index + match[0].length
  }
  element.appendChild(document.createTextNode(text.slice(offset)))
  return element
}
const money = (value: number | null, currency: string) => value === null ? 'Needs review' : staffPaymentMoney(value, currency)
const flags: Record<string, string> = {
  incomplete_month: 'Work month is still open', inactive_contractor: 'Contractor is inactive',
  missing_rate: 'Some hours have no cost rate', changed_source: 'Hours or rates changed since review',
  currency_mismatch: 'Earnings currency needs review', historical_settlement: 'Historically settled; no new payment proposed',
  unconfirmed_earnings: 'Confirm earnings first', unreviewed_earnings: 'Review captured hours first',
  unavailable_balance: 'Payable balance is not available', earnings_override: 'Recorded earnings differ from captured hours',
  review_selection_override: 'Reviewer changed the selected hours', allocation_attention: 'Review existing allocations',
  advance_attention: 'Review advance credit history', missing_received_invoice: 'No received invoice for this currency',
  advance_requires_target_review: 'Advance has a different month or an intended project; choose its target explicitly',
  overpaid_or_reserved: 'Payments or reservations exceed earnings',
}
const flagText = (flag: string) => flags[flag] ?? (flag.startsWith('invoice_') ? 'Invoice needs review; open contractor invoices for details' : 'Needs review in the related section')
type Row = { person: ContractorReviewPerson; balance: ContractorCurrencyReview }

export const createContractorReviewController = (
  page: HTMLElement,
  api: ContractorReviewApi,
  errorText: (error: unknown) => string,
  navigate: (tab: PaymentTab) => void,
) => {
  const panel = page.querySelector<HTMLElement>('[data-contractor-review]')!
  const host = panel.querySelector<HTMLElement>('[data-contractor-review-content]')!
  const status = panel.querySelector<HTMLElement>('[data-contractor-review-status]')!
  const loadButton = panel.querySelector<HTMLButtonElement>('[data-contractor-review-load]')!
  let signal: AbortSignal | null = null
  let month: string | null = null
  let generation = 0
  const reset = () => {
    generation++
    month = null
    loadButton.disabled = true
    host.replaceChildren()
    status.textContent = ''
  }
  const paint = (review: ContractorReview) => {
    host.replaceChildren(node('p', `Work month ${review.month}. Advance credit activity through ${review.credit_period.to}. Currencies are reviewed separately.`))
    const rows = review.people.flatMap(person => person.currencies.map(balance => ({ person, balance })))
    host.appendChild(renderDataTable<Row>({
      table: 'contractor-reconciliation', defaultSort: { column: 'name', direction: 'ascending' },
      caption: 'Contractor reconciliation by currency', rows,
      rowKey: r => `${r.person.user_id}:${r.balance.currency}`,
      empty: 'No contractor earnings, invoices, payments or advances for this month.',
      columns: [
        { key: 'name', label: 'Person', sortValue: r => r.person.name, render: r => r.person.name },
        { key: 'currency', label: 'Currency', sortValue: r => r.balance.currency, render: r => r.balance.currency },
        { key: 'phase', label: 'Status', sortValue: r => r.person.phase, render: r => r.person.phase === 'review' ? 'Ready to review' : r.person.phase === 'attention' ? 'Needs attention' : r.person.phase.charAt(0).toUpperCase() + r.person.phase.slice(1) },
        ...([
          ['recorded_earnings_cents', 'Recorded earnings'], ['proposed_earnings_cents', 'Earnings from hours'],
          ['paid_cents', 'Paid'], ['reserved_cents', 'Reserved'], ['available_to_pay_cents', 'Current payable'],
          ['available_credit_cents', 'Available advance credit'], ['proposed_credit_cents', 'Proposed credit'],
          ['remaining_after_credit_cents', 'Payable after proposed credit'],
        ] as const).map(([key, label]) => ({
          key, label, numeric: true,
          sortValue: (r: Row) => r.balance[key] === null ? null : [r.balance.currency, r.balance[key]!] as const,
          render: (r: Row) => r.balance[key] === null ? 'Needs review' : moneyText(money(r.balance[key], r.balance.currency)),
        })),
      ],
    }))
    for (const { person, balance } of rows) {
      const detail = node('details')
      detail.appendChild(node('summary', `${person.name} · ${balance.currency} · Review evidence`))
      const reasons = node('ul')
      for (const flag of balance.flags) reasons.appendChild(node('li', flagText(flag)))
      detail.appendChild(reasons)
      detail.appendChild(node('p', `Current payable: ${money(balance.available_to_pay_cents, balance.currency)}. After proposed credit: ${money(balance.remaining_after_credit_cents, balance.currency)} (projection). Proposed changes require confirmation; loading this review sends no money.`))
      const latest = person.latest_review
      if (latest) {
        const actor = person.ledger_events.find(event => event.actor_id === latest.actor_id)?.actor_name ?? `Person ${latest.actor_id}`
        detail.appendChild(node('p', `Last earnings review: ${actor}, ${latest.recorded_at}. ${latest.note}`))
      }
      const links = node('p')
      for (const [tab, label] of [['actuals', 'Review hours and earnings'], ['invoices', 'Review invoices'], ['allocations', 'Review allocations'], ['advances', 'Review advance credit']] as const) {
        const button = node('button', label)
        button.type = 'button'
        button.addEventListener('click', () => navigate(tab))
        links.appendChild(button)
        links.appendChild(document.createTextNode(' '))
      }
      detail.appendChild(links)
      const section = (title: string, lines: string[], empty: string) => {
        detail.appendChild(node('h3', title))
        const list = node('ul')
        for (const text of lines.length ? lines : [empty]) list.appendChild(node('li', text))
        detail.appendChild(list)
      }
      section('Captured hours', person.entries.map(entry => `${entry.spent_date} · ${entry.project_name} · ${(entry.rounded_seconds / 3600).toFixed(2)} hours captured; ${(entry.selected_seconds / 3600).toFixed(2)} selected · ${entry.cost_rate_cents === null ? 'Missing cost rate' : 'Cost rate captured; review actuals for its currency'}`), 'No captured hours.')
      section('Invoice history', balance.invoices.flatMap(invoice => invoice.versions.map(version => `${invoice.reference} · Version ${version.version} · ${version.kind === 'void' ? 'Voided' : version.kind === 'received' ? 'Received' : 'Draft'} · ${money(version.amount_cents, version.currency)} · ${version.recorded_at} · ${version.reason}`)), 'No invoice for this currency.')
      for (const invoice of balance.invoices) {
        for (const flag of invoice.flags) detail.appendChild(node('p', `${invoice.reference}: ${flag}`))
        const latest = invoice.versions.at(-1)
        if (latest?.document_id) {
          const link = node('a', `Open document for ${invoice.reference}, version ${latest.version}`)
          link.href = `/api/v1/staff-invoices/${invoice.id}/documents/${encodeURIComponent(latest.document_id)}/content`
          detail.appendChild(link)
        }
      }
      section('Ledger and receipt history', person.ledger_events.filter(event => event.currency === balance.currency || event.currency === null).map(event => `${event.kind === 'payment' ? 'Receipt' : event.kind === 'amount' ? 'Earnings recorded' : event.kind === 'void' ? 'Voided receipt' : event.kind === 'opening' ? 'Historical settlement' : event.kind === 'reopen' ? 'Settlement reopened' : 'Note'} · ${money(event.amount_cents, event.currency ?? balance.currency)} · ${event.reference} · ${event.actor_name}, ${event.recorded_at} · ${event.note}`), 'No recorded ledger events.')
      section('Recorded allocations', balance.allocations.map(allocation => `${money(allocation.amount_cents, allocation.currency)} · ${allocation.scope === 'month' ? 'Work month' : allocation.project_name ?? 'Selected hours'} · ${allocation.state} · ${allocation.recorded_at} · ${allocation.reason}`), 'No recorded allocations.')
      section('Advance intent and balances', balance.advances.map(advance => `${advance.month} · ${advance.advance_project_id === null ? 'No intended project' : `Intended project ${advance.advance_project_id}`} · ${advance.advance_reason} · ${advance.state} · Available ${money(advance.available_cents, advance.currency)}; pending ${money(advance.reserved_cents, advance.currency)}`), 'No advance credit.')
      section('Proposed monthly allocations', balance.allocation_proposals.map(proposal => `${money(proposal.amount_cents, balance.currency)} from an existing receipt to this work month`), 'No new receipt allocation proposed.')
      section('Proposed monthly credit applications', balance.credit_proposals.map(proposal => `${money(proposal.amount_cents, balance.currency)} of settled advance credit to this work month`), 'No new credit application proposed.')
      section('Payment progress', balance.items.map(item => `${item.run_name} · ${item.purpose === 'advance' ? 'Advance' : 'Earnings'} · ${money(item.amount_cents, balance.currency)} · ${item.phase} · ${item.attempts} attempts${item.failure ? ` · ${item.failure}` : ''}`), 'No payment run items.')
      host.appendChild(detail)
    }
  }
  loadButton.addEventListener('click', () => {
    const active = signal, selectedMonth = month
    if (!active || active.aborted || !selectedMonth || !api.getContractorReview) return
    const own = ++generation
    host.replaceChildren()
    status.textContent = 'Loading contractor reconciliation…'
    loadButton.disabled = true
    void api.getContractorReview(selectedMonth, active).then(review => {
      if (active.aborted || own !== generation) return
      if (review.month !== selectedMonth) throw new Error('The review month changed. Reload the payment register.')
      paint(review)
      status.textContent = 'Review loaded. Confirm proposed changes in the related sections, then reload.'
    }).catch(error => {
      if (!active.aborted && own === generation) status.textContent = errorText(error)
    }).finally(() => {
      if (!active.aborted && own === generation) loadButton.disabled = false
    })
  })
  return {
    reset,
    ledger: (report: StaffPaymentReport, active: AbortSignal) => {
      reset()
      signal = active
      month = report.month
      loadButton.disabled = active.aborted || !api.getContractorReview
      if (!api.getContractorReview) status.textContent = 'Contractor reconciliation is unavailable.'
    },
    activate: (active: AbortSignal) => {
      reset()
      signal = active
      active.addEventListener('abort', () => { if (signal === active) { reset(); signal = null } }, { once: true })
    },
  }
}
