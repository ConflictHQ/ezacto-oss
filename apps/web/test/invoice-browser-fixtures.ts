import type { Invoice, InvoiceLine, InvoicePayment, Whoami } from '@conflict-hq/ezacto-client'
import { renderAppShell } from '../src/shell/render.js'
import { webAssets } from '../src/index.js'

// Share production-markup fixtures across files. Each test file receives its
// own happy-dom Window, bounding retained shell parses without dropping checks.
export const timestamp = '2026-08-28T12:00:00.000Z'

export const identity = (userId: number): Whoami => ({
  user_id: userId,
  profile: 'accounting',
  manager_grants: [],
  authentication: { kind: 'session' },
})

export const invoice = (number: string, overrides: Partial<Invoice> = {}): Invoice => ({
  id: 7,
  client_id: 1,
  created_by_user_id: 1,
  number,
  subject: null,
  purchase_order: null,
  notes: null,
  currency: 'USD',
  issue_date: '2026-08-01',
  due_date: '2026-08-31',
  payment_terms: 'net_30',
  state: 'open',
  version: 1,
  close_reason: null,
  close_write_off_cents: 0,
  sent_at: timestamp,
  paid_at: null,
  paid_date: null,
  closed_at: null,
  period_start: null,
  period_end: null,
  project_id: null,
  retainer_id: null,
  recurring_invoice_id: null,
  estimate_id: null,
  reminder_policy: null,
  tax_rate_ppm: null,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  amount_cents: 1_000,
  due_amount_cents: 1_000,
  tax_amount_cents: 0,
  tax2_amount_cents: 0,
  discount_amount_cents: 0,
  written_off_cents: 0,
  payment_options: [],
  reference_token: null,
  created_at: timestamp,
  updated_at: timestamp,
  line_items: [],
  ...overrides,
})

export const payment = (overrides: Partial<InvoicePayment> = {}): InvoicePayment => ({
  id: 11,
  invoice_id: 7,
  currency: 'USD',
  amount_cents: 500,
  paid_at: null,
  paid_date: '2026-08-20',
  notes: 'Private first-session note',
  recorded_by_user_id: 1,
  provider: 'manual',
  provider_shape: 'manual',
  provider_account_id: null,
  provider_transaction_id: null,
  bank_deposit_id: null,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

export const line = (overrides: Partial<InvoiceLine> = {}): InvoiceLine => ({
  id: 21,
  invoice_id: 7,
  position: 0,
  kind: 'Service',
  description: 'Initial work',
  quantity: 1,
  unit_price_cents: 1_000,
  amount_cents: 1_000,
  taxed: false,
  taxed2: false,
  project_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

export const deferred = <Value>() => {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve: (value: Value) => resolve?.(value) }
}

/**
 * The detail page, by default at the record id: the fixtures here vary the
 * number from test to test and read the invoice by id, so the id address is
 * the one that needs no lookup. The number addresses have tests of their own.
 */
export const renderDetail = (path = '/invoices/by-id/7', demo = false): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'invoice-browser-test',
      activeSection: 'Invoices',
      view: 'invoice-detail',
      // The demo's mail is always held to its allowlist, as the Worker serves it.
      demo,
      demoMailRestricted: demo,
    })
      .replace(/ {2}<link[^>]+>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

/**
 * What the browser is left with on paper. happy-dom resolves `@media print`
 * against a screen, so the served block is lifted out and applied on its own --
 * after the full stylesheet, which is both where the print rules sit in the
 * file and how they win. `@page` is dropped because it describes the sheet
 * rather than any element.
 */
export const applyPrintRules = (): void => {
  const source = webAssets.stylesheet
  const start = source.indexOf('@media print {')
  if (start === -1) throw new Error('the served stylesheet carries no print rules')
  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) throw new Error('the print block is unbalanced')
  const screen = document.createElement('style')
  screen.textContent = source
  const paper = document.createElement('style')
  paper.textContent = source
    .slice(open + 1, end)
    .replace(/@page\s*\{[^}]*\}/u, '')
  document.head.append(screen, paper)
}

export const painted = (selector: string): CSSStyleDeclaration => {
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  return window.getComputedStyle(element)
}

export const submit = (selector: string): void => {
  document
    .querySelector<HTMLFormElement>(selector)!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

