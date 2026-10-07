/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type Invoice,
  type InvoiceLine,
  type InvoicePayment,
  type InvoicePaymentInput,
  type InvoiceQuickBooksEnvelope,
  type InvoiceTransitionInput,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createInvoicePaymentController, setInvoiceClientNames } from '../src/invoices/browser.js'
import {
  invoiceQuickBooksLine,
  invoiceRemindersLine,
  type InvoiceDocumentPreference,
  type InvoiceEmailDefaults,
  type InvoicePaymentApi,
  type InvoiceReminderPreference,
} from '../src/invoices/model.js'
import { leavePageNotice } from '../src/page-notice.js'
import { renderAppShell } from '../src/shell/render.js'
import { contrastRatio, defaultTheme, themeManifest, webAssets } from '../src/index.js'

const timestamp = '2026-08-28T12:00:00.000Z'

const identity = (userId: number): Whoami => ({
  user_id: userId,
  profile: 'accounting',
  manager_grants: [],
  authentication: { kind: 'session' },
})

const invoice = (number: string, overrides: Partial<Invoice> = {}): Invoice => ({
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

const payment = (overrides: Partial<InvoicePayment> = {}): InvoicePayment => ({
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

const line = (overrides: Partial<InvoiceLine> = {}): InvoiceLine => ({
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

const deferred = <Value>() => {
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
const renderDetail = (path = '/invoices/by-id/7'): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'invoice-browser-test',
      activeSection: 'Invoices',
      view: 'invoice-detail',
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
const applyPrintRules = (): void => {
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

const painted = (selector: string): CSSStyleDeclaration => {
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  return window.getComputedStyle(element)
}

const submit = (selector: string): void => {
  document
    .querySelector<HTMLFormElement>(selector)!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

describe('invoice payment controller', () => {
  it('[security] rejects stale detail responses and clears private payment state on abort', async () => {
    renderDetail()
    const firstInvoice = deferred<Invoice>()
    let invoiceLoad = 0
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(() => {
        invoiceLoad += 1
        return invoiceLoad === 1
          ? firstInvoice.promise
          : Promise.resolve(invoice('SECOND', { notes: 'Second-session invoice' }))
      }),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi
        .fn()
        .mockResolvedValueOnce([payment()])
        .mockResolvedValueOnce([]),
    }
    const controller = createInvoicePaymentController(api)
    const firstAbort = new AbortController()
    const firstActivation = controller.activate(identity(1), firstAbort.signal, () => false)
    firstAbort.abort()
    const secondAbort = new AbortController()
    await controller.activate(identity(2), secondAbort.signal, () => false)
    firstInvoice.resolve(invoice('FIRST', { notes: 'Private first-session invoice' }))
    await firstActivation

    const article = document.querySelector<HTMLElement>('[data-invoice-document]')!
    expect(article.hidden).toBe(false)
    expect(article.textContent).toContain('SECOND')
    expect(article.textContent).toContain('Second-session invoice')
    expect(article.textContent).not.toContain('FIRST')
    expect(article.textContent).not.toContain('Private first-session note')

    secondAbort.abort()
    expect(article.hidden).toBe(true)
    expect(article.textContent).not.toContain('SECOND')
    expect(article.textContent).not.toContain('Second-session invoice')
    expect(document.title).not.toContain('SECOND')
    expect(document.querySelector('[data-invoice-detail-payments]')?.textContent).toBe('')
    expect(document.querySelector('[data-invoice-detail-messages]')?.textContent).toBe('')
  })

  it('[security] resets an in-flight mutation between users and ignores its late result', async () => {
    renderDetail()
    const pendingRecord = deferred<Invoice>()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    let selectedSession = 1
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () =>
        selectedSession === 1
          ? invoice('FIRST')
          : invoice('SECOND', { notes: 'Only second user can see this', due_date: '2099-08-31' }),
      ),
      // The first session moved the address onto the invoice's number, so the
      // second reads the page from there.
      findInvoiceByNumber: vi.fn(async (number: string) =>
        number === 'FIRST' ? invoice('FIRST') : null,
      ),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      recordInvoicePayment: vi.fn(() => pendingRecord.promise),
    }
    const controller = createInvoicePaymentController(api)
    await controller.activate(identity(1), firstAbort.signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')!.click()
    submit('[data-invoice-payment-form]')
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[data-invoice-payment-amount]')?.disabled).toBe(
        true,
      ),
    )

    firstAbort.abort()
    selectedSession = 2
    await controller.activate(identity(2), secondAbort.signal, () => false)
    const record = document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')!
    expect(record.disabled).toBe(false)
    expect(document.querySelector<HTMLDialogElement>('[data-invoice-payment-dialog]')?.open).toBe(
      false,
    )
    pendingRecord.resolve(
      invoice('FIRST-PAID', { state: 'paid', due_amount_cents: 0, paid_date: '2026-08-28' }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('[data-invoice-detail-number]')?.textContent).toBe('SECOND')
    // The fixture carries sent_at, so this reads Sent.
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Sent')
    expect(document.querySelector('[data-invoice-detail-notes]')?.textContent).toBe(
      'Only second user can see this',
    )
  })

  it('[conflict] refreshes versions, preserves edits, and uses a new retry identity', async () => {
    renderDetail()
    let currentInvoice = invoice('CONFLICT')
    let currentPayment = payment({ notes: 'Before conflict' })
    let attempts = 0
    const commandIds: string[] = []
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => [currentPayment]),
      updateInvoicePayment: vi.fn(
        async (_invoiceId, _paymentId, commandId, input) => {
          attempts += 1
          commandIds.push(commandId)
          if (attempts === 1) {
            currentInvoice = { ...currentInvoice, version: 2 }
            currentPayment = {
              ...currentPayment,
              notes: 'Concurrent server edit',
              updated_at: '2026-08-29T12:00:00.000Z',
            }
            throw new EzactoApiError(
              409,
              {
                error: {
                  code: 'invoice_version_conflict',
                  message: 'server conflict',
                  fields: [],
                },
              },
              null,
            )
          }
          expect(input.expected_version).toBe(2)
          expect(input.expected_updated_at).toBe('2026-08-29T12:00:00.000Z')
          currentInvoice = { ...currentInvoice, version: 3, due_amount_cents: 400 }
          currentPayment = {
            ...currentPayment,
            amount_cents: input.amount_cents,
            notes: input.notes ?? null,
            updated_at: '2026-08-30T12:00:00.000Z',
          }
          return currentInvoice
        },
      ),
    }
    const controller = createInvoicePaymentController(api)
    const abort = new AbortController()
    await controller.activate(identity(1), abort.signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-invoice-payment-edit="11"]')!.click()
    const amount = document.querySelector<HTMLInputElement>('[data-invoice-payment-amount]')!
    const notes = document.querySelector<HTMLTextAreaElement>('[data-invoice-payment-notes]')!
    amount.value = '6.00'
    notes.value = 'Preserve this correction'
    notes.dispatchEvent(new Event('input', { bubbles: true }))
    submit('[data-invoice-payment-form]')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-payment-result]')?.textContent).toContain(
        'Latest values are loaded',
      ),
    )
    expect(amount.value).toBe('6.00')
    expect(notes.value).toBe('Preserve this correction')
    expect(amount.disabled).toBe(false)

    submit('[data-invoice-payment-form]')
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>('[data-invoice-payment-dialog]')?.open).toBe(
        false,
      ),
    )
    expect(commandIds).toHaveLength(2)
    expect(commandIds[0]).not.toBe(commandIds[1])
    expect(document.querySelector('[data-invoice-detail-due]')?.textContent).toBe('$4.00')
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toBe(
      'Payment saved.',
    )
  })

  it.each(['record', 'update', 'delete'] as const)(
    '[reliability] treats a successful %s as complete when its detail refresh fails',
    async (operation) => {
      renderDetail()
      const initialPayment = payment()
      let committed = false
      let detailLoads = 0
      const refreshedInvoice = invoice('REFRESHED', {
        version: 2,
        state: operation === 'record' ? 'paid' : 'open',
        due_amount_cents: operation === 'record' ? 0 : operation === 'delete' ? 1_000 : 500,
      })
      const refreshedPayments =
        operation === 'delete'
          ? []
          : [payment({ amount_cents: operation === 'record' ? 1_000 : 500 })]
      const getInvoice = vi.fn(async () => {
        detailLoads += 1
        if (detailLoads === 2) throw new Error('refresh unavailable')
        return committed ? refreshedInvoice : invoice('INITIAL')
      })
      const recordInvoicePayment = vi.fn(async () => {
        committed = true
        return refreshedInvoice
      })
      const updateInvoicePayment = vi.fn(async () => {
        committed = true
        return refreshedInvoice
      })
      const deleteInvoicePayment = vi.fn(async () => {
        committed = true
        return refreshedInvoice
      })
      const api: Partial<InvoicePaymentApi> = {
        getInvoice,
        listInvoiceMessages: vi.fn(async () => []),
        listInvoicePayments: vi.fn(async () =>
          committed ? refreshedPayments : operation === 'record' ? [] : [initialPayment],
        ),
        recordInvoicePayment,
        updateInvoicePayment,
        deleteInvoicePayment,
      }
      const controller = createInvoicePaymentController(api)
      await controller.activate(identity(1), new AbortController().signal, () => false)

      if (operation === 'record') {
        document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')!.click()
        submit('[data-invoice-payment-form]')
      } else if (operation === 'update') {
        document.querySelector<HTMLButtonElement>('[data-invoice-payment-edit="11"]')!.click()
        submit('[data-invoice-payment-form]')
      } else {
        document.querySelector<HTMLButtonElement>('[data-invoice-payment-delete="11"]')!.click()
        submit('[data-invoice-payment-delete-form]')
      }

      const mutation =
        operation === 'record'
          ? recordInvoicePayment
          : operation === 'update'
            ? updateInvoicePayment
            : deleteInvoicePayment
      await vi.waitFor(() =>
        expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toContain(
          'will not be submitted again',
        ),
      )
      expect(mutation).toHaveBeenCalledTimes(1)
      expect(document.querySelector<HTMLDialogElement>('[data-invoice-payment-dialog]')?.open).toBe(
        false,
      )
      expect(
        document.querySelector<HTMLDialogElement>('[data-invoice-payment-delete-dialog]')?.open,
      ).toBe(false)
      expect(document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')?.disabled).toBe(
        true,
      )
      for (const staleAction of document.querySelectorAll<HTMLButtonElement>(
        '[data-invoice-payment-edit], [data-invoice-payment-delete]',
      )) {
        expect(staleAction.disabled).toBe(true)
      }

      document.querySelector<HTMLInputElement>('[data-invoice-payment-amount]')!.value = '9.99'
      submit(
        operation === 'delete'
          ? '[data-invoice-payment-delete-form]'
          : '[data-invoice-payment-form]',
      )
      await Promise.resolve()
      expect(mutation).toHaveBeenCalledTimes(1)

      document.querySelector<HTMLButtonElement>('[data-invoice-detail-retry]')!.click()
      await vi.waitFor(() =>
        expect(document.querySelector('[data-invoice-detail-number]')?.textContent).toBe(
          'REFRESHED',
        ),
      )
      expect(getInvoice).toHaveBeenCalledTimes(3)
      expect(mutation).toHaveBeenCalledTimes(1)
      expect(document.querySelector<HTMLButtonElement>('[data-invoice-detail-retry]')?.hidden).toBe(
        true,
      )
    },
  )

  it('[security] clears the invoice immediately when a mutation loses its session', async () => {
    renderDetail()
    const sessionFailure = vi.fn(() => true)
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () => invoice('SESSION')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      recordInvoicePayment: vi.fn(async () => {
        throw new EzactoApiError(
          401,
          { error: { code: 'authentication_required', message: 'expired', fields: [] } },
          null,
        )
      }),
    }
    const controller = createInvoicePaymentController(api)
    await controller.activate(identity(1), new AbortController().signal, sessionFailure)
    document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')!.click()
    submit('[data-invoice-payment-form]')

    await vi.waitFor(() => expect(sessionFailure).toHaveBeenCalled())
    expect(document.querySelector<HTMLElement>('[data-invoice-document]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLDialogElement>('[data-invoice-payment-dialog]')?.open).toBe(
      false,
    )
    expect(document.querySelector('[data-invoice-detail-payments]')?.textContent).toBe('')
  })

  it('[e2e:invoice-payment] settles the whole balance from the button and retries under one command id', async () => {
    renderDetail()
    let currentInvoice = invoice('SETTLE', { amount_cents: 100_000, due_amount_cents: 62_500 })
    const recorded: InvoicePayment[] = []
    let failNext = true
    const recordInvoicePayment = vi.fn(
      async (_invoiceId: number, _commandId: string, input: InvoicePaymentInput) => {
        if (failNext) {
          failNext = false
          throw new EzactoApiError(
            500,
            { error: { code: 'internal_error', message: 'the ledger is unavailable', fields: [] } },
            null,
          )
        }
        // The input is a union of the two timings; the button always sends a date.
        const paidDate = 'paid_date' in input ? input.paid_date : null
        recorded.push(payment({ amount_cents: input.amount_cents, paid_date: paidDate }))
        currentInvoice = {
          ...currentInvoice,
          due_amount_cents: currentInvoice.due_amount_cents - input.amount_cents,
          state: 'paid',
          paid_date: paidDate,
          version: input.expected_version + 1,
        }
        return currentInvoice
      },
    )
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => recorded),
      recordInvoicePayment,
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)

    const settle = document.querySelector<HTMLButtonElement>('[data-invoice-payment-settle]')!
    // The sum is on the button, so the reader knows what the click costs before
    // it happens rather than after.
    expect(settle.hidden).toBe(false)
    expect(settle.disabled).toBe(false)
    expect(settle.textContent).toBe('Mark paid \u00b7 $625.00')
    // In the header with Print, Edit and Send, not below the line items with
    // the payment list: an operator who reads the header and finds no way to
    // mark a sent invoice paid concludes there is none (issue 812).
    expect(settle.closest('.invoice-document-actions')).not.toBeNull()
    expect(settle.closest('.invoice-payment-history')).toBeNull()

    settle.click()
    await vi.waitFor(() => expect(recordInvoicePayment).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(settle.disabled).toBe(false))
    // A failed settle is one attempt, not a recorded payment, and it never routes
    // through the dialog.
    expect(document.querySelector<HTMLDialogElement>('[data-invoice-payment-dialog]')?.open).toBe(
      false,
    )
    // The failure reads next to the button that caused it: the page status line
    // above the document, not the Payments section below the line items.
    expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toContain(
      'the ledger is unavailable',
    )
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toBe('')

    settle.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
        'Invoice marked paid.',
      ),
    )
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toBe('')
    expect(recordInvoicePayment).toHaveBeenCalledTimes(2)
    const [first, second] = recordInvoicePayment.mock.calls
    // Held, not rotated: the retry is the same intent, so the server sees one
    // command and settles the balance once even if the first attempt landed.
    expect(second![1]).toBe(first![1])
    expect(second![1]).toMatch(/^web\.invoice\.payment\.record:/u)
    expect(second![2]).toEqual({
      expected_version: 1,
      amount_cents: 62_500,
      currency: 'USD',
      paid_date: new Date().toLocaleDateString('en-CA'),
      notes: null,
    })
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Paid')
    // Nothing is left due, so the button that settles a balance is refused --
    // and says the same reason Record payment does, on the same pass.
    expect(settle.disabled).toBe(true)
    expect(settle.title).toBe('This invoice has no remaining amount due.')
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')!.title).toBe(
      settle.title,
    )
  })

  it('[e2e:invoice-cycle] reports a Mark paid conflict beside the header button, not below the fold', async () => {
    renderDetail()
    // Version 3 with $625 due; another operator records $300 (version 4) before
    // this click lands, so the settle is refused with a conflict.
    let currentInvoice = invoice('SETTLE', {
      amount_cents: 100_000,
      due_amount_cents: 62_500,
      version: 3,
    })
    let settleAttempt: { reject: (error: unknown) => void } | null = null
    const recordInvoicePayment = vi.fn(
      () =>
        new Promise<Invoice>((_resolve, reject) => {
          settleAttempt = { reject }
        }),
    )
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      recordInvoicePayment,
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)

    const settle = document.querySelector<HTMLButtonElement>('[data-invoice-payment-settle]')!
    const pageStatus = document.querySelector<HTMLElement>('[data-invoice-detail-status]')!
    const paymentStatus = document.querySelector<HTMLElement>('[data-invoice-payment-status]')!
    expect(settle.textContent).toBe('Mark paid \u00b7 $625.00')

    settle.click()
    await vi.waitFor(() => expect(recordInvoicePayment).toHaveBeenCalledTimes(1))
    expect(settle.disabled).toBe(true)
    // Progress, too, sits by the button, and the Payments line stays empty.
    expect(pageStatus.textContent).toBe('Recording payment\u2026')
    expect(paymentStatus.textContent).toBe('')

    currentInvoice = { ...currentInvoice, due_amount_cents: 32_500, version: 4 }
    settleAttempt!.reject(
      new EzactoApiError(
        409,
        { error: { code: 'invoice_version_conflict', message: 'server conflict', fields: [] } },
        null,
      ),
    )
    await vi.waitFor(() =>
      expect(pageStatus.textContent).toBe(
        'The invoice, line, or payment changed elsewhere. Latest values are loaded; review and try again.',
      ),
    )
    // The reload relabelled the button with the new balance; the sentence that
    // explains why is in the same viewport as the button, not in the Payments
    // section under the line items, totals and notes.
    expect(settle.disabled).toBe(false)
    expect(settle.textContent).toBe('Mark paid \u00b7 $325.00')
    expect(paymentStatus.textContent).toBe('')
    expect(document.querySelector<HTMLDialogElement>('[data-invoice-payment-dialog]')?.open).toBe(
      false,
    )
  })

  it('[e2e:invoice-cycle] keeps every header action a 44px touch target on a phone', () => {
    // The e2e suite measures Mark paid with expectPhoneControl at 390px, which
    // demands 44px. Under the Payments heading it had that; the header row was
    // 40px, and nothing at the 720px breakpoint raised it.
    // Edit invoice is a link now, and keeps the header's floor with the rest.
    expect(webAssets.stylesheet).toMatch(
      /\.invoice-document-actions button,\n\.invoice-document-actions \.invoice-edit-link \{\s*min-height: 44px;/u,
    )
  })

  it('[browser] sends every change to the invoice through its edit page', async () => {
    // The edit dialog and the line dialogs were two editors over the same rows
    // with different save semantics. The edit page is the one now, and every
    // way in from here leads to it -- opened on the line, or on a fresh one.
    renderDetail()
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('LINKS', { line_items: [line()] })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)

    const edit = document.querySelector<HTMLAnchorElement>('[data-invoice-edit]')!
    expect(edit.tagName).toBe('A')
    expect(edit.hidden).toBe(false)
    expect(edit.getAttribute('href')).toBe('/invoices/LINKS/edit')
    expect(edit.hasAttribute('aria-disabled')).toBe(false)
    const add = document.querySelector<HTMLAnchorElement>('[data-invoice-line-add]')!
    expect(add.hidden).toBe(false)
    expect(add.getAttribute('href')).toBe('/invoices/LINKS/edit#new-line')
    const lineEdit = document.querySelector<HTMLAnchorElement>('[data-invoice-line-edit="21"]')!
    expect(lineEdit.getAttribute('href')).toBe('/invoices/LINKS/edit#line-21')
    // Removing a line happens on the edit page too, where it can be undone
    // until the page saves; there is no second, immediate delete here.
    expect(document.querySelector('[data-invoice-line-delete]')).toBeNull()
    expect(document.querySelector('[data-invoice-line-dialog]')).toBeNull()
    expect(document.querySelector('[data-invoice-edit-dialog]')).toBeNull()
  })

  it('[browser] offers no way into the editor for a closed invoice, and says why', async () => {
    renderDetail()
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () =>
        invoice('CLOSED', { state: 'closed', close_reason: 'cancelled', line_items: [line()] }),
      ),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)

    const edit = document.querySelector<HTMLAnchorElement>('[data-invoice-edit]')!
    expect(edit.hidden).toBe(false)
    // An anchor with no href goes nowhere and takes no focus: the disabled
    // state a link has, with the reason where the old button kept it.
    expect(edit.hasAttribute('href')).toBe(false)
    expect(edit.getAttribute('aria-disabled')).toBe('true')
    expect(edit.title).toBe('A closed invoice can no longer be edited.')
    const add = document.querySelector<HTMLAnchorElement>('[data-invoice-line-add]')!
    expect(add.hasAttribute('href')).toBe(false)
    expect(add.title).toBe('Line items cannot be changed on a closed invoice.')
    expect(document.querySelector('[data-invoice-line-edit]')).toBeNull()
  })

  it('[security] shows a read-scoped token no way into the editor', async () => {
    renderDetail()
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('READ', { line_items: [line()] })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    })
    await controller.activate(
      {
        ...identity(1),
        authentication: { kind: 'token', token_id: 3, scopes: ['invoices:read'] },
      },
      new AbortController().signal,
      () => false,
    )
    expect(document.querySelector<HTMLElement>('[data-invoice-edit]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-invoice-line-add]')?.hidden).toBe(true)
    expect(document.querySelector('[data-invoice-line-edit]')).toBeNull()
    expect(document.querySelector<HTMLElement>('[data-invoice-line-readonly]')?.hidden).toBe(false)
  })

  it('[browser] says what the edit page saved once the document is up, and only once', async () => {
    // The editor goes back to the invoice's number, and leaves the notice there.
    renderDetail('/invoices/SAVED')
    leavePageNotice('/invoices/SAVED', 'Invoice saved.')
    const api: Partial<InvoicePaymentApi> = {
      findInvoiceByNumber: vi.fn(async (number: string) =>
        number === 'SAVED' ? invoice('SAVED') : null,
      ),
      getInvoice: vi.fn(async () => invoice('SAVED')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }
    const status = (): string =>
      document.querySelector('[data-invoice-detail-status]')?.textContent ?? ''
    await createInvoicePaymentController(api).activate(
      identity(1),
      new AbortController().signal,
      () => false,
    )
    expect(status()).toBe('Invoice saved.')

    renderDetail('/invoices/SAVED')
    await createInvoicePaymentController(api).activate(
      identity(1),
      new AbortController().signal,
      () => false,
    )
    expect(status()).toBe('')
  })

  it('[browser] opens the invoice its number names, leading zero and all, and looks it up once', async () => {
    renderDetail('/invoices/0089')
    const findInvoiceByNumber = vi.fn(async (number: string) =>
      number === '0089' ? invoice('0089') : null,
    )
    const getInvoice = vi.fn(async () => invoice('0089'))
    const listInvoiceMessages = vi.fn(async () => [])
    const listInvoicePayments = vi.fn(async () => [])
    await createInvoicePaymentController({
      findInvoiceByNumber,
      getInvoice,
      listInvoiceMessages,
      listInvoicePayments,
      recordInvoicePayment: vi.fn(async () =>
        invoice('0089', { state: 'paid', due_amount_cents: 0, paid_date: '2026-08-28' }),
      ),
    }).activate(identity(1), new AbortController().signal, () => false)

    // Asked as the text in the address -- "0089", not 89 -- and from there
    // the page reads the record by its id, as it always has.
    expect(findInvoiceByNumber).toHaveBeenCalledWith('0089', expect.any(AbortSignal))
    expect(getInvoice).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(listInvoiceMessages).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(listInvoicePayments).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(document.querySelector('[data-invoice-detail-number]')?.textContent).toBe('0089')
    expect(globalThis.location.pathname).toBe('/invoices/0089')

    // The refresh after a payment reads the invoice the page already is,
    // rather than looking its number up again.
    document.querySelector<HTMLButtonElement>('[data-invoice-payment-settle]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
        'Invoice marked paid.',
      ),
    )
    expect(getInvoice).toHaveBeenCalledTimes(2)
    expect(findInvoiceByNumber).toHaveBeenCalledTimes(1)
  })

  it('[browser] opened by id, lands on the number with its query and hash', async () => {
    renderDetail('/invoices/by-id/7?from=report#payments')
    const entries = globalThis.history.length
    const findInvoiceByNumber = vi.fn(async () => null)
    const getInvoice = vi.fn(async () => invoice('4021'))
    await createInvoicePaymentController({
      findInvoiceByNumber,
      getInvoice,
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }).activate(identity(1), new AbortController().signal, () => false)

    expect(getInvoice).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(findInvoiceByNumber).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-detail-number]')?.textContent).toBe('4021')
    expect(globalThis.location.pathname).toBe('/invoices/4021')
    expect(globalThis.location.search).toBe('?from=report')
    expect(globalThis.location.hash).toBe('#payments')
    // Replaced rather than pushed: going back leaves the invoice, it does not
    // revisit the id.
    expect(globalThis.history.length).toBe(entries)
  })

  it('[browser] stays on the id when the number cannot be its address', async () => {
    // A space is not a path segment, and "new" is the New invoice dialog.
    for (const number of ['INV 7', 'new']) {
      renderDetail()
      await createInvoicePaymentController({
        getInvoice: vi.fn(async () => invoice(number)),
        listInvoiceMessages: vi.fn(async () => []),
        listInvoicePayments: vi.fn(async () => []),
      }).activate(identity(1), new AbortController().signal, () => false)
      expect(document.querySelector('[data-invoice-detail-number]')?.textContent).toBe(number)
      expect(globalThis.location.pathname).toBe('/invoices/by-id/7')
    }
  })

  it('[browser] says so when no invoice has the number in the address, and reads nothing else', async () => {
    renderDetail('/invoices/89')
    const findInvoiceByNumber = vi.fn(async (number: string) =>
      number === '089' ? invoice('089') : null,
    )
    const getInvoice = vi.fn(async () => invoice('089'))
    await createInvoicePaymentController({
      findInvoiceByNumber,
      getInvoice,
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }).activate(identity(1), new AbortController().signal, () => false)

    // "89" is not "089": no invoice has that number, so nothing is read.
    expect(findInvoiceByNumber).toHaveBeenCalledWith('89', expect.any(AbortSignal))
    expect(getInvoice).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
      'The requested invoice does not exist.',
    )
    expect(document.querySelector<HTMLElement>('[data-invoice-document]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-detail-retry]')?.hidden).toBe(
      false,
    )
  })

  it('[browser] names the client on a page opened directly, and reads the name once', async () => {
    // Saving in the editor lands here on a fresh page, where nobody has loaded
    // the client's name yet. The page painted "Client #1" -- an internal id on
    // a document a client is sent -- so it reads the one name it shows.
    setInvoiceClientNames([])
    renderDetail('/invoices/SAVED')
    const getDirectoryClient = vi.fn(async (id: number) => ({
      id,
      name: '  Kestrel Environmental ',
      created_at: timestamp,
      updated_at: timestamp,
    }))
    const getInvoice = vi.fn(async () => invoice('SAVED'))
    await createInvoicePaymentController({
      findInvoiceByNumber: vi.fn(async () => invoice('SAVED')),
      getInvoice,
      getDirectoryClient,
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      recordInvoicePayment: vi.fn(async () =>
        invoice('SAVED', { state: 'paid', due_amount_cents: 0, paid_date: '2026-08-28' }),
      ),
    }).activate(identity(1), new AbortController().signal, () => false)

    expect(getDirectoryClient).toHaveBeenCalledWith(1, expect.any(AbortSignal))
    expect(document.querySelector('[data-invoice-detail-client]')?.textContent).toBe(
      'Kestrel Environmental',
    )

    // A refresh shows the same client, and does not ask for it again.
    document.querySelector<HTMLButtonElement>('[data-invoice-payment-settle]')!.click()
    await vi.waitFor(() => expect(getInvoice).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
        'Invoice marked paid.',
      ),
    )
    expect(document.querySelector('[data-invoice-detail-client]')?.textContent).toBe(
      'Kestrel Environmental',
    )
    expect(getDirectoryClient).toHaveBeenCalledTimes(1)
    setInvoiceClientNames([])
  })

  it('[browser] still shows the invoice when its client cannot be read', async () => {
    // A token without clients:read, or a request that failed: the name is a
    // nicety, and the invoice is the page.
    setInvoiceClientNames([])
    renderDetail()
    await createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('UNNAMED')),
      getDirectoryClient: vi.fn(async () => {
        throw new EzactoApiError(403, { error: { code: 'forbidden', message: 'No.' } }, null)
      }),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }).activate(identity(1), new AbortController().signal, () => false)

    expect(document.querySelector<HTMLElement>('[data-invoice-document]')?.hidden).toBe(false)
    expect(document.querySelector('[data-invoice-detail-number]')?.textContent).toBe('UNNAMED')
    expect(document.querySelector('[data-invoice-detail-client]')?.textContent).toBe('Client #1')
  })

  it('[e2e:invoice-state] issues write off from the overflow and gates every other verb', async () => {
    renderDetail()
    let currentInvoice = invoice('STATE', { state: 'open', due_amount_cents: 1_000 })
    const recorded = [payment()]
    const transitionInvoice = vi.fn(
      async (_invoiceId: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'closed',
          close_reason: 'written_off',
          close_write_off_cents: currentInvoice.due_amount_cents,
          written_off_cents: currentInvoice.due_amount_cents,
          due_amount_cents: 0,
          version: input.expected_version + 1,
        }
        return currentInvoice
      },
    )
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => recorded),
      transitionInvoice,
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)

    const toggle = document.querySelector<HTMLButtonElement>('[data-invoice-overflow-toggle]')!
    const menu = document.querySelector<HTMLElement>('[data-invoice-overflow-menu]')!
    const item = (command: string): HTMLButtonElement =>
      document.querySelector<HTMLButtonElement>(`[data-invoice-transition="${command}"]`)!
    expect(toggle.hidden).toBe(false)
    expect(menu.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggle.click()
    expect(menu.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // A payment is recorded, so returning to draft is illegal and is not shown.
    expect(item('draft').hidden).toBe(true)
    expect(item('reopen').hidden).toBe(true)
    expect(item('write_off').hidden).toBe(false)
    expect(item('cancel').hidden).toBe(false)
    // Destructive is red text on the document ground, never a red fill.
    expect(item('write_off').className).toContain('invoice-overflow-destructive')
    expect(item('cancel').className).toContain('invoice-overflow-destructive')
    expect(item('draft').className).not.toContain('invoice-overflow-destructive')

    item('write_off').click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-transition-dialog]')!
    expect(dialog.open).toBe(true)
    expect(menu.hidden).toBe(true)
    expect(document.querySelector('[data-invoice-transition-summary]')?.textContent).toContain(
      'writes off the balance still due',
    )
    const confirm = document.querySelector<HTMLButtonElement>('[data-invoice-transition-submit]')!
    expect(confirm.textContent).toBe('Write off balance')
    expect(confirm.className).toBe('invoice-destructive-action')

    submit('[data-invoice-transition-form]')
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(transitionInvoice).toHaveBeenCalledWith(
      7,
      expect.stringMatching(/^web\.invoice\.write_off:/u),
      { command: 'write_off', expected_version: 1 },
      expect.any(AbortSignal),
    )
    // The state the UI could always render and no operator could reach.
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Written off')
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toBe(
      'Invoice is now written off.',
    )
    expect(item('reopen').hidden).toBe(false)
    expect(item('write_off').hidden).toBe(true)
    expect(item('cancel').hidden).toBe(true)
  })
  it('[browser] prints the invoice and not the application around it', async () => {
    renderDetail()
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () =>
        invoice('INV-PRINT', { line_items: [line()], notes: 'Thank you for your business.' }),
      ),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => [payment()]),
    }
    const controller = createInvoicePaymentController(api)
    await controller.activate(identity(1), new AbortController().signal, () => false)
    applyPrintRules()

    // The chrome. The top bar is the worst of it: white text on --ez-ink, so
    // with background graphics off -- the print default -- it printed as an
    // empty band above the invoice.
    for (const selector of ['.topbar', '.tabstrip', '.build-stamp']) {
      expect(painted(selector).display).toBe('none')
    }
    // The controls that change the invoice, and the internal record of who was
    // sent what, are the application rather than the bill.
    for (const selector of [
      '[data-invoice-print]',
      '[data-invoice-send]',
      // A link now, and still the application rather than the bill.
      '[data-invoice-edit]',
      '.invoice-line-editor',
      '.invoice-line-actions',
      '.invoice-attachment-section',
      '[data-invoice-payment-record]',
      '[aria-labelledby="invoice-message-heading"]',
      '[data-invoice-detail-status]',
      '[data-invoice-detail-page] .context-row',
    ]) {
      expect(painted(selector).display).toBe('none')
    }
    // The document itself, and the payments already applied to it, stay.
    expect(painted('[data-invoice-document]').display).not.toBe('none')
    expect(painted('.invoice-payment-history').display).not.toBe('none')
    expect(painted('[data-invoice-detail-lines] tr').display).toBe('table-row')
    expect(painted('.invoice-document').paddingTop).toBe('0px')
    expect(painted('.invoice-document').borderTopWidth).toBe('0px')

    // #378 again: the state is the one thing on this document whose meaning was
    // a background fill, and a fill is what does not print. It has to stand on
    // ink -- a border and a colour that clears 4.5:1 against bare paper.
    const state = painted('.invoice-state')
    const paper = themeManifest[defaultTheme].colors.ground
    expect(state.backgroundColor).toBe('transparent')
    expect(state.borderTopWidth).toBe('1px')
    expect(contrastRatio(state.color, paper)).toBeGreaterThanOrEqual(4.5)
  })

  it('[browser] gives the document a print control of its own', async () => {
    renderDetail()
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () => invoice('INV-PRINT')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }
    const controller = createInvoicePaymentController(api)
    await controller.activate(identity(1), new AbortController().signal, () => false)

    const print = vi.fn()
    Object.defineProperty(window, 'print', { configurable: true, value: print })
    const button = document.querySelector<HTMLButtonElement>('[data-invoice-print]')!
    // Reading an invoice is enough: printing changes nothing and is never
    // disabled with the editing controls.
    expect(button.disabled).toBe(false)
    button.click()
    expect(print).toHaveBeenCalledTimes(1)
  })
})

describe('the QuickBooks line and Sync button (issue 819)', () => {
  type QuickBooksState = InvoiceQuickBooksEnvelope['data']
  const notConnected: QuickBooksState = {
    connected: false,
    invoice: null,
    payments: [],
    last_outcome: null,
  }
  const refusedBeforeConnect: QuickBooksState = {
    connected: true,
    invoice: null,
    payments: [],
    last_outcome: {
      kind: 'refused',
      reason: 'QuickBooks is not connected',
      at: '2026-09-16T12:00:00.000Z',
    },
  }
  const synced: QuickBooksState = {
    connected: true,
    invoice: { quickbooks_id: '147', mirrored_at: '2026-09-17T12:00:00.000Z' },
    payments: [{ payment_id: 11, quickbooks_id: '148', mirrored_at: '2026-09-17T12:00:01.000Z' }],
    last_outcome: { kind: 'created', reason: null, at: '2026-09-17T12:00:01.000Z' },
  }
  const line = (): string =>
    document.querySelector('[data-invoice-detail-quickbooks]')!.textContent ?? ''
  const fact = (): HTMLElement => document.querySelector('[data-invoice-quickbooks-fact]')!
  const button = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('[data-invoice-quickbooks-sync]')!
  const day = (value: string): string => value.slice(0, 10)

  it('[unit] says each state in one line', () => {
    expect(invoiceQuickBooksLine(notConnected, day)).toBe('Not connected')
    expect(invoiceQuickBooksLine(refusedBeforeConnect, day)).toBe(
      'Not synced: QuickBooks is not connected',
    )
    expect(
      invoiceQuickBooksLine({ ...refusedBeforeConnect, last_outcome: null }, day),
    ).toBe('Not synced')
    expect(invoiceQuickBooksLine(synced, day)).toBe(
      'Synced to QuickBooks invoice 147 on 2026-09-17 \u00b7 1 payment synced',
    )
    expect(invoiceQuickBooksLine({ ...synced, payments: [] }, day)).toBe(
      'Synced to QuickBooks invoice 147 on 2026-09-17',
    )
    // A receipt the mirror could not file is not settled because the invoice was.
    expect(
      invoiceQuickBooksLine(
        {
          ...synced,
          last_outcome: { kind: 'failed', reason: 'token lapsed', at: synced.last_outcome!.at },
        },
        day,
      ),
    ).toBe(
      'Synced to QuickBooks invoice 147 on 2026-09-17 \u00b7 1 payment synced \u00b7 last attempt failed: token lapsed',
    )
  })

  it('[browser] shows neither the line nor the button where the build has no QuickBooks routes', async () => {
    renderDetail()
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('NOQB')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      recordInvoicePayment: vi.fn(),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-document]')!.hasAttribute('hidden')).toBe(false),
    )
    expect(fact().hidden).toBe(true)
    expect(button().hidden).toBe(true)
  })

  it('[browser] a deployment without Intuit keys answers 404 and the page shows no line', async () => {
    renderDetail()
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('NOKEYS')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      getInvoiceQuickBooks: vi.fn(async () => {
        throw new EzactoApiError(404, { error: { code: 'not_found', message: 'Not found' } }, null)
      }),
      syncInvoiceQuickBooks: vi.fn(),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-document]')!.hasAttribute('hidden')).toBe(false),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fact().hidden).toBe(true)
    expect(button().hidden).toBe(true)
  })

  it('[e2e:invoice-quickbooks] renders the refusal, syncs on press, and the line follows', async () => {
    renderDetail()
    let state = refusedBeforeConnect
    const getInvoiceQuickBooks = vi.fn(async () => state)
    const syncInvoiceQuickBooks = vi.fn(async () => {
      state = synced
      return synced
    })
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('SYNC')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => [payment()]),
      getInvoiceQuickBooks,
      syncInvoiceQuickBooks,
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)

    // Recorded by the outbox before anybody connected; the page says so before
    // a button is pressed.
    await vi.waitFor(() => expect(line()).toBe('Not synced: QuickBooks is not connected'))
    expect(fact().hidden).toBe(false)
    expect(button().hidden).toBe(false)
    expect(button().disabled).toBe(false)
    // In the header with the other document actions, not below the fold.
    expect(button().closest('.invoice-document-actions')).not.toBeNull()

    button().click()
    expect(button().disabled).toBe(true)
    expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
      'Syncing to QuickBooks…',
    )
    await vi.waitFor(() => expect(button().disabled).toBe(false))
    expect(syncInvoiceQuickBooks).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(line()).toBe('Synced to QuickBooks invoice 147 on Sep 17, 2026 \u00b7 1 payment synced')
    expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
      'Synced to QuickBooks invoice 147 with 1 payment.',
    )
  })

  it('[e2e:invoice-quickbooks] a refused sync names the reason beside the button and on the line', async () => {
    renderDetail()
    let state: QuickBooksState = {
      connected: true,
      invoice: null,
      payments: [],
      last_outcome: null,
    }
    const reason =
      'QuickBooks already has a customer named Kestrel Environmental \u2014 Northpeak under a different parent'
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('REFUSED')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      getInvoiceQuickBooks: vi.fn(async () => state),
      syncInvoiceQuickBooks: vi.fn(async () => {
        state = {
          ...state,
          last_outcome: { kind: 'refused', reason, at: '2026-09-17T12:00:00.000Z' },
        }
        throw new EzactoApiError(
          409,
          { error: { code: 'quickbooks_refused', message: reason, fields: [] } },
          null,
        )
      }),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() => expect(line()).toBe('Not synced'))

    button().click()
    await vi.waitFor(() => expect(button().disabled).toBe(false))
    expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
      `QuickBooks refused the invoice: ${reason}`,
    )
    // Re-read after the refusal, so the line keeps saying why once the status
    // line has moved on to something else.
    expect(line()).toBe(`Not synced: ${reason}`)
  })

  it('[browser] the button waits for a connection and for a sent invoice', async () => {
    renderDetail()
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('DRAFT', { state: 'draft', sent_at: null })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      getInvoiceQuickBooks: vi.fn(async () => notConnected),
      syncInvoiceQuickBooks: vi.fn(),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() => expect(line()).toBe('Not connected'))
    expect(button().hidden).toBe(false)
    expect(button().disabled).toBe(true)
    expect(button().title).toBe('Connect QuickBooks under Settings → Integrations first.')

    // Connected, but the invoice is still a draft: the mirror will not put a
    // document nobody has raised into somebody's books, and the button says so.
    renderDetail()
    const drafted = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('DRAFT', { state: 'draft', sent_at: null })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      getInvoiceQuickBooks: vi.fn(async () => ({ ...notConnected, connected: true })),
      syncInvoiceQuickBooks: vi.fn(),
    })
    await drafted.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() => expect(line()).toBe('Not synced'))
    expect(button().disabled).toBe(true)
    expect(button().title).toBe('Drafts are not mirrored. Send the invoice first.')

    // Cancelled or written off: not a receivable anybody should find in their
    // books. The runtime refuses it too; the button says so before the round trip.
    renderDetail()
    const closed = createInvoicePaymentController({
      getInvoice: vi.fn(async () =>
        invoice('CLOSED', { state: 'closed', close_reason: 'cancelled', sent_at: null }),
      ),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      getInvoiceQuickBooks: vi.fn(async () => ({ ...notConnected, connected: true })),
      syncInvoiceQuickBooks: vi.fn(),
    })
    await closed.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() => expect(line()).toBe('Not synced'))
    expect(button().disabled).toBe(true)
    expect(button().title).toBe('A closed invoice is not mirrored.')
  })

  it('[e2e:invoice-quickbooks] Mark paid re-reads the line, so a receipt the outbox filed shows up', async () => {
    renderDetail()
    let currentInvoice = invoice('PAID', { amount_cents: 1_000, due_amount_cents: 1_000 })
    let state: QuickBooksState = { ...synced, payments: [] }
    const getInvoiceQuickBooks = vi.fn(async () => state)
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      recordInvoicePayment: vi.fn(async (_id: number, _command: string, input: InvoicePaymentInput) => {
        state = synced
        currentInvoice = {
          ...currentInvoice,
          due_amount_cents: 0,
          state: 'paid',
          version: input.expected_version + 1,
        }
        return currentInvoice
      }),
      getInvoiceQuickBooks,
      syncInvoiceQuickBooks: vi.fn(),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() => expect(line()).toBe('Synced to QuickBooks invoice 147 on Sep 17, 2026'))

    document.querySelector<HTMLButtonElement>('[data-invoice-payment-settle]')!.click()
    await vi.waitFor(() =>
      expect(line()).toBe('Synced to QuickBooks invoice 147 on Sep 17, 2026 \u00b7 1 payment synced'),
    )
    expect(getInvoiceQuickBooks).toHaveBeenCalledTimes(2)
  })
})

describe('the Reminders fact and its switch (issue 850)', () => {
  const day = (value: string) => value
  const following: InvoiceReminderPreference = {
    invoice_id: 7,
    reminders: null,
    organization_reminder_policy: { first_after_days: 3, every_days: 7 },
    effective: true,
    next_reminder_at: '2026-09-18T00:00:00.000Z',
  }
  const off: InvoiceReminderPreference = { ...following, reminders: false, effective: false, next_reminder_at: null }
  const fact = () => document.querySelector<HTMLElement>('[data-invoice-reminders-fact]')!
  const line = () => document.querySelector('[data-invoice-detail-reminders]')!.textContent
  const toggle = () => document.querySelector<HTMLInputElement>('[data-invoice-reminders-toggle]')!

  it('[unit] says off, the next date, or that there is no policy', () => {
    expect(invoiceRemindersLine(following, day)).toBe('Next reminder 2026-09-18')
    expect(invoiceRemindersLine(off, day)).toBe('Off for this invoice')
    expect(
      invoiceRemindersLine({ ...following, organization_reminder_policy: null, next_reminder_at: null }, day),
    ).toBe('No reminder policy set for the organization')
    expect(invoiceRemindersLine({ ...following, next_reminder_at: null }, day)).toBe('None booked')
  })

  it('[browser] shows no fact where the build has no route, or the invoice is not open', async () => {
    renderDetail()
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('DRAFT', { state: 'draft', sent_at: null })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      getInvoiceReminderPreference: vi.fn(async () => following),
      setInvoiceReminderPreference: vi.fn(),
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-document]')!.hasAttribute('hidden')).toBe(false),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fact().hidden).toBe(true)
  })

  it('[e2e:invoice-reminders] the switch turns reminders off for this invoice and hands them back', async () => {
    // The client said they will pay. Off is a statement about this invoice;
    // on is null, so a default set later governs it again.
    renderDetail()
    let state = following
    const setInvoiceReminderPreference = vi.fn(async (_id: number, reminders: boolean | null) => {
      state = reminders === false ? off : following
      return state
    })
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('REM')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      getInvoiceReminderPreference: vi.fn(async () => state),
      setInvoiceReminderPreference,
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    await vi.waitFor(() => expect(line()).toBe('Next reminder Sep 18, 2026'))
    expect(fact().hidden).toBe(false)
    expect(toggle().checked).toBe(true)

    toggle().checked = false
    toggle().dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(line()).toBe('Off for this invoice'))
    expect(setInvoiceReminderPreference).toHaveBeenLastCalledWith(expect.any(Number), false, expect.any(AbortSignal))
    expect(toggle().checked).toBe(false)
    expect(toggle().disabled).toBe(false)

    toggle().checked = true
    toggle().dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(line()).toBe('Next reminder Sep 18, 2026'))
    expect(setInvoiceReminderPreference).toHaveBeenLastCalledWith(expect.any(Number), null, expect.any(AbortSignal))
  })
})

describe('the Send dialog attachments', () => {
  const preference = (overrides: Partial<InvoiceDocumentPreference> = {}): InvoiceDocumentPreference => ({
    invoice_id: 7,
    attach_pdf: false,
    client_attach_pdf: null,
    organization_attach_pdf: false,
    effective: false,
    attach_files: false,
    client_attach_files: null,
    organization_attach_files: false,
    effective_files: false,
    append_pdfs: null,
    client_append_pdfs: null,
    organization_append_pdfs: false,
    effective_append_pdfs: false,
    attach_journal: false,
    client_attach_journal: null,
    organization_attach_journal: false,
    effective_journal: false,
    journal_formats: null,
    client_journal_formats: null,
    organization_journal_formats: ['pdf'],
    effective_journal_formats: ['pdf'],
    ...overrides,
  })

  /**
   * A draft with one staged file, sent from the dialog. Every request lands
   * in `calls` in the order it was made, which is what these tests are about:
   * the attachments are written before anything is sent, or not at all.
   */
  const sending = (overrides: Partial<InvoicePaymentApi> = {}) => {
    renderDetail()
    let current = invoice('SEND', {
      state: 'draft',
      sent_at: null,
      due_date: '2099-09-30',
      line_items: [line()],
    })
    let stored = preference()
    const calls: string[] = []
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () => current),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      listInvoiceAttachments: vi.fn(async () => [
        {
          id: 5,
          name: 'purchase-order.pdf',
          content_hash: 'sha256-fixture',
          byte_size: 2_048,
          content_type: 'application/pdf',
          uploaded_by_user_id: 1,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ]),
      getInvoiceDocumentPreference: vi.fn(async () => stored),
      setInvoiceDocumentPreference: vi.fn(async (_id: number, input) => {
        calls.push('preference')
        stored = preference({
          effective: input.attach_pdf ?? stored.effective,
          effective_journal: input.attach_journal ?? stored.effective_journal,
          effective_journal_formats: input.journal_formats ?? stored.effective_journal_formats,
        })
        return stored
      }),
      transitionInvoice: vi.fn(
        async (_id: number, _key: string, input: InvoiceTransitionInput) => {
          calls.push('send')
          current = {
            ...current,
            state: 'open',
            sent_at: timestamp,
            version: input.expected_version + 1,
          }
          return current
        },
      ),
      deliverInvoiceEmail: vi.fn(async (_id: number, _key: string, input) => {
        calls.push('deliver')
        current = { ...current, version: input.expected_version + 1 }
        return current
      }),
      ...overrides,
    }
    return { api, calls }
  }

  const box = (selector: string): HTMLInputElement =>
    document.querySelector<HTMLInputElement>(selector)!

  const openComposer = async (api: Partial<InvoicePaymentApi>): Promise<void> => {
    await createInvoicePaymentController(api).activate(
      identity(1),
      new AbortController().signal,
      () => false,
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-attachment-status]')?.textContent).toBe(
        '1 file attached.',
      ),
    )
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    // The dialog opens on the invoice's own answer, read for this opening.
    await vi.waitFor(() =>
      expect(api.getInvoiceDocumentPreference).toHaveBeenCalledWith(7, expect.any(AbortSignal)),
    )
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-invoice-composer-attachments-status]')?.textContent,
      ).not.toBe('Reading what this invoice attaches…'),
    )
  }

  const deliverTo = (recipient: string): void => {
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = recipient
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    // Delivering is what the dialog opens on; the confirmation is what it asks.
    expect(box('[data-invoice-composer-deliver-toggle]').checked).toBe(true)
    box('[data-invoice-composer-confirm]').click()
  }

  it('[e2e:invoice-email] opens on what the invoice attaches, and saves only what changed before sending', async () => {
    const { api, calls } = sending()
    await openComposer(api)

    // The dialog opens delivering, so the attachments are on offer at once,
    // each on the invoice's own answer.
    const pdf = box('[data-invoice-composer-attach-pdf]')
    expect(pdf.disabled).toBe(false)
    expect(pdf.checked).toBe(false)
    // They go with the email, so recording alone puts them away.
    box('[data-invoice-composer-deliver-toggle]').click()
    expect(pdf.disabled).toBe(true)
    expect(document.querySelector('[data-invoice-composer-attachments-status]')?.textContent).toBe(
      'Attachments go with the email, so they are chosen once it is to be delivered.',
    )
    box('[data-invoice-composer-deliver-toggle]').click()
    // The file is staged, so attaching files is a choice on offer.
    expect(
      document.querySelector<HTMLElement>('[data-invoice-composer-attach-files-label]')?.hidden,
    ).toBe(false)
    deliverTo('Accounts Payable <ap@example.test>')
    expect(pdf.disabled).toBe(false)
    pdf.click()
    const journal = box('[data-invoice-composer-attach-journal]')
    journal.click()
    const level = document.querySelector<HTMLSelectElement>('[data-invoice-composer-journal-level]')!
    expect(level.hidden).toBe(false)
    level.value = 'summary'
    box('[data-invoice-composer-journal-formats] input[value="csv"]').click()
    submit('[data-invoice-composer-form]')

    await vi.waitFor(() => expect(calls).toEqual(['preference', 'send', 'deliver']))
    expect(api.setInvoiceDocumentPreference).toHaveBeenCalledWith(
      7,
      { attach_pdf: true, attach_journal: 'summary', journal_formats: ['pdf', 'csv'] },
      expect.any(AbortSignal),
    )
    // Recorded on the message, as Harvest recorded it.
    expect(api.transitionInvoice).toHaveBeenCalledWith(
      7,
      expect.any(String),
      expect.objectContaining({ command: 'send', attach_pdf: true }),
      expect.any(AbortSignal),
    )
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')?.open).toBe(
        false,
      ),
    )
  })

  it('[reliability] sends nothing when the attachments are refused, and a retry is the same send', async () => {
    const setInvoiceDocumentPreference = vi
      .fn<NonNullable<InvoicePaymentApi['setInvoiceDocumentPreference']>>()
      .mockRejectedValueOnce(
        new EzactoApiError(500, { error: { code: 'internal_error', message: 'Storage unavailable.' } }, null),
      )
      .mockImplementation(async () => preference({ effective: true }))
    let sends = 0
    const transitionInvoice = vi.fn(
      async (_id: number, _key: string, input: InvoiceTransitionInput) => {
        sends += 1
        if (sends === 1) throw new Error('network unavailable')
        return invoice('SEND', { state: 'open', sent_at: timestamp, version: input.expected_version + 1 })
      },
    )
    const { api, calls } = sending({ setInvoiceDocumentPreference, transitionInvoice })
    await openComposer(api)
    deliverTo('ap@example.test')
    box('[data-invoice-composer-attach-pdf]').click()

    submit('[data-invoice-composer-form]')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'The attachment choices were not saved, so nothing was sent: Storage unavailable. Submit again to retry.',
      ),
    )
    expect(transitionInvoice).not.toHaveBeenCalled()
    expect(calls).toEqual([])

    // Saved this time; the send itself then fails on the way.
    submit('[data-invoice-composer-form]')
    await vi.waitFor(() => expect(transitionInvoice).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'network unavailable',
      ),
    )
    // Saving the choices again would write what is already written: the
    // retry is the send alone, under the key it was first sent with.
    submit('[data-invoice-composer-form]')
    await vi.waitFor(() => expect(transitionInvoice).toHaveBeenCalledTimes(2))
    expect(setInvoiceDocumentPreference).toHaveBeenCalledTimes(2)
    expect(transitionInvoice.mock.calls[1]?.[1]).toBe(transitionInvoice.mock.calls[0]?.[1])
  })

  it('[browser] says when it cannot read the attachments, and sends without touching them', async () => {
    const { api, calls } = sending({
      getInvoiceDocumentPreference: vi.fn(async () => {
        throw new EzactoApiError(503, { error: { code: 'unavailable', message: 'down' } }, null)
      }),
      listInvoiceAttachments: vi.fn(async () => []),
    })
    await createInvoicePaymentController(api).activate(identity(1), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-attachments-status]')?.textContent).toBe(
        'What this invoice attaches could not be read, so the email goes with its saved choices.',
      ),
    )
    // No staged files, so no files to offer.
    expect(
      document.querySelector<HTMLElement>('[data-invoice-composer-attach-files-label]')?.hidden,
    ).toBe(true)
    deliverTo('ap@example.test')
    expect(box('[data-invoice-composer-attach-pdf]').disabled).toBe(true)
    submit('[data-invoice-composer-form]')
    await vi.waitFor(() => expect(calls).toEqual(['send', 'deliver']))
    expect(api.setInvoiceDocumentPreference).not.toHaveBeenCalled()
    expect(api.transitionInvoice).toHaveBeenCalledWith(
      7,
      expect.any(String),
      expect.objectContaining({ attach_pdf: false }),
      expect.any(AbortSignal),
    )
  })

  /** What the client and the organization say the email opens on. */
  const defaults = (overrides: Partial<InvoiceEmailDefaults> = {}): InvoiceEmailDefaults => ({
    invoice_id: 7,
    client_id: 1,
    company_name: 'Example Studio LLC',
    client_name: 'Northwind Example Co',
    template_version: 2,
    subject: 'Invoice #%invoice_number% from %company_name%',
    message: 'Happy Friday! Please find this month\'s invoice below.\n\nAna',
    to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
    cc: [
      { name: 'Pat Example', email: 'pat@northwind.example' },
      { name: '', email: 'lee@northwind.example' },
    ],
    recipients_source: 'client',
    always_cc: [{ name: 'Finance', email: 'finance@example.com' }],
    sender: { name: 'Ana Example', email: 'ana@example.com' },
    send_me_a_copy: true,
    delivery: { available: true, code: null, message: null },
    ...overrides,
  })

  const field = (selector: string): HTMLTextAreaElement =>
    document.querySelector<HTMLTextAreaElement>(selector)!

  const openWithDefaults = async (api: Partial<InvoicePaymentApi>): Promise<void> => {
    await openComposer(api)
    await vi.waitFor(() =>
      expect(field('[data-invoice-composer-recipients]').value).toBe(
        'Accounts Payable <ap@northwind.example>',
      ),
    )
  }

  it('[e2e:invoice-email] opens on the client\'s To and Cc, the copies and the template\'s words', async () => {
    const { api } = sending({ getInvoiceEmailDefaults: vi.fn(async () => defaults()) })
    await openWithDefaults(api)
    expect(field('[data-invoice-composer-cc]').value).toBe(
      'Pat Example <pat@northwind.example>\nlee@northwind.example',
    )
    expect(document.querySelector<HTMLInputElement>('[data-invoice-composer-subject]')!.value).toBe(
      'Invoice #%invoice_number% from %company_name%',
    )
    expect(field('[data-invoice-composer-body]').value).toBe(
      "Happy Friday! Please find this month's invoice below.\n\nAna",
    )
    expect(document.querySelector('[data-invoice-composer-recipients-source]')?.textContent).toBe(
      "From this client's saved recipients.",
    )
    expect(document.querySelector('[data-invoice-composer-always-cc]')?.textContent).toBe(
      'Also copied on every invoice email: Finance <finance@example.com>.',
    )
    expect(document.querySelector<HTMLElement>('[data-invoice-composer-copy-label]')?.hidden).toBe(false)
    expect(box('[data-invoice-composer-copy]').checked).toBe(true)
    expect(document.querySelector('[data-invoice-composer-copy-address]')?.textContent).toBe(
      '(ana@example.com)',
    )
    // The misleading line that said the email ignored this dialog is gone.
    expect(document.querySelector('[data-invoice-composer-dialog]')?.textContent).not.toContain(
      'not the subject and message above',
    )
  })

  it('[e2e:invoice-email] sends one email To and Cc, in the words typed, and saves the client\'s defaults first', async () => {
    const setClientInvoiceSending = vi.fn(async () => {
      calls.push('client')
    })
    const setInvoiceCopyToSelf = vi.fn(async () => {
      calls.push('copy')
    })
    const { api, calls } = sending({
      getInvoiceEmailDefaults: vi.fn(async () => defaults()),
      setClientInvoiceSending,
      setInvoiceCopyToSelf,
    })
    await openWithDefaults(api)
    box('[data-invoice-composer-confirm]').click()
    const cc = field('[data-invoice-composer-cc]')
    cc.value = `${cc.value}\nFinance Team <finance@example.com>`
    box('[data-invoice-composer-copy]').click()
    box('[data-invoice-composer-attach-pdf]').click()
    box('[data-invoice-composer-append]').click()
    box('[data-invoice-composer-save-default]').click()
    submit('[data-invoice-composer-form]')

    await vi.waitFor(() => expect(calls).toEqual(['client', 'preference', 'copy', 'send', 'deliver']))
    expect(setClientInvoiceSending).toHaveBeenCalledWith(
      1,
      {
        recipients: {
          to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
          cc: [
            { name: 'Pat Example', email: 'pat@northwind.example' },
            { name: '', email: 'lee@northwind.example' },
            { name: 'Finance Team', email: 'finance@example.com' },
          ],
        },
        attach_pdf: true,
        append_pdfs: true,
        attach_files: false,
        attach_journal: false,
      },
      expect.any(AbortSignal),
    )
    expect(setInvoiceCopyToSelf).toHaveBeenCalledWith(false, expect.any(AbortSignal))
    // The record of the send, filled in the browser...
    expect(api.transitionInvoice).toHaveBeenCalledWith(
      7,
      expect.any(String),
      expect.objectContaining({
        recipients: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        subject: 'Invoice #SEND from Example Studio LLC',
        send_me_a_copy: false,
      }),
      expect.any(AbortSignal),
    )
    // ...and the email itself, composed by the server from what was typed.
    expect(api.deliverInvoiceEmail).toHaveBeenCalledWith(
      7,
      expect.any(String),
      {
        expected_version: 2,
        recipients: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        cc: [
          { name: 'Pat Example', email: 'pat@northwind.example' },
          { name: '', email: 'lee@northwind.example' },
          { name: 'Finance Team', email: 'finance@example.com' },
        ],
        subject: 'Invoice #%invoice_number% from %company_name%',
        message: "Happy Friday! Please find this month's invoice below.\n\nAna",
        send_me_a_copy: false,
        confirmed: true,
      },
      expect.any(AbortSignal),
    )
  })

  it('[reliability] refuses a variable an invoice email does not have, before anything is recorded', async () => {
    const { api, calls } = sending({ getInvoiceEmailDefaults: vi.fn(async () => defaults()) })
    await openWithDefaults(api)
    box('[data-invoice-composer-confirm]').click()
    document.querySelector<HTMLInputElement>('[data-invoice-composer-subject]')!.value =
      'Invoice %invoice_numbr%'
    submit('[data-invoice-composer-form]')
    expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
      'Subject: %invoice_numbr% is not a variable an invoice email has.',
    )
    expect(calls).toEqual([])
  })

  it('[e2e:invoice-email] previews the email the send would make, and sends a stamped copy to me only', async () => {
    const previewInvoiceEmail = vi.fn(async () => ({
      email: {
        invoice_id: 7,
        from: { name: 'Example Studio LLC', email: 'billing@example.com' },
        reply_to: null,
        to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        cc: [
          { name: 'Pat Example', email: 'pat@northwind.example' },
          { name: 'Ana Example', email: 'ana@example.com' },
        ],
        send_me_a_copy: true,
        subject: 'Invoice #SEND from Example Studio LLC',
        text: 'Happy Friday!\n\nAmount Due: $10.00 USD',
        html: null,
        attachments: [
          {
            kind: 'invoice' as const,
            filename: 'INVOICE_SEND_EXAMPLE_STUDIO_LLC.pdf',
            content_type: 'application/pdf',
            byte_size: 154_000,
            appended: ['purchase-order.pdf'],
            not_appended: null,
          },
        ],
      },
      documentHref: '/api/v1/invoices/7/deliveries/preview/document?append_pdfs=true',
    }))
    const sendInvoiceEmailPreview = vi.fn(async () => ({
      to: [{ name: 'Ana Example', email: 'ana@example.com' }],
    }))
    const { api, calls } = sending({
      getInvoiceEmailDefaults: vi.fn(async () => defaults()),
      previewInvoiceEmail,
      sendInvoiceEmailPreview,
    })
    await openWithDefaults(api)
    box('[data-invoice-composer-attach-pdf]').click()
    box('[data-invoice-composer-append]').click()
    document.querySelector<HTMLButtonElement>('[data-invoice-composer-preview]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-invoice-composer-preview-panel]')?.hidden).toBe(
        false,
      ),
    )
    expect(previewInvoiceEmail).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        recipients: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        subject: 'Invoice #%invoice_number% from %company_name%',
        send_me_a_copy: true,
        attach_pdf: true,
        append_pdfs: true,
      }),
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-invoice-preview-to]')?.textContent).toBe(
      'Accounts Payable <ap@northwind.example>',
    )
    expect(document.querySelector('[data-invoice-preview-cc]')?.textContent).toBe(
      'Pat Example <pat@northwind.example>, Ana Example <ana@example.com>',
    )
    expect(document.querySelector('[data-invoice-preview-subject]')?.textContent).toBe(
      'Invoice #SEND from Example Studio LLC',
    )
    expect(document.querySelector('[data-invoice-preview-text]')?.textContent).toBe(
      'Happy Friday!\n\nAmount Due: $10.00 USD',
    )
    expect(document.querySelector('[data-invoice-preview-attachments]')?.textContent).toBe(
      'INVOICE_SEND_EXAMPLE_STUDIO_LLC.pdf (154 kB) — with purchase-order.pdf at the back',
    )
    const download = document.querySelector<HTMLAnchorElement>('[data-invoice-preview-document]')!
    expect(download.hidden).toBe(false)
    expect(download.getAttribute('href')).toBe(
      '/api/v1/invoices/7/deliveries/preview/document?append_pdfs=true',
    )

    document.querySelector<HTMLButtonElement>('[data-invoice-composer-preview-send]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-preview-result]')?.textContent).toBe(
        'A preview went to ana@example.com only, stamped PREVIEW. Nothing was sent to the client.',
      ),
    )
    // Neither is a send: nothing was recorded, nothing was delivered.
    expect(calls).toEqual([])
  })

  it('[browser] says a preview needs email delivery where the instance has none', async () => {
    // What the server sends for a 503: a request id and nothing a person can act on.
    const unavailable = new EzactoApiError(
      503,
      {
        error: {
          code: 'internal_error',
          message: 'The request could not be completed.',
          fields: [],
        },
      },
      null,
    )
    const { api, calls } = sending({
      getInvoiceEmailDefaults: vi.fn(async () => defaults()),
      previewInvoiceEmail: vi.fn(async () => {
        throw unavailable
      }),
    })
    await openWithDefaults(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-composer-preview]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-preview-result]')?.textContent).toBe(
        'Email delivery is not set up on this instance, so there is no email to preview.',
      ),
    )
    expect(document.querySelector<HTMLElement>('[data-invoice-composer-preview-panel]')?.hidden).toBe(
      true,
    )
    expect(calls).toEqual([])
  })

  const submitLabel = (): string | null | undefined =>
    document.querySelector('[data-invoice-composer-submit]')?.textContent

  const shown = (selector: string): boolean =>
    document.querySelector<HTMLElement>(selector)?.hidden === false

  it('[browser] emails the invoice when the operator confirms the recipients and presses the button', async () => {
    // The reported send: the dialog's button pressed, and the invoice recorded
    // as sent with no email -- delivery opened unticked and the button still
    // said "Send invoice". Now the box opens ticked and the button says so.
    const { api, calls } = sending({ getInvoiceEmailDefaults: vi.fn(async () => defaults()) })
    await openWithDefaults(api)
    expect(box('[data-invoice-composer-deliver-toggle]').checked).toBe(true)
    expect(submitLabel()).toBe('Send and deliver')
    expect(shown('[data-invoice-composer-no-email]')).toBe(false)
    expect(shown('[data-invoice-composer-delivery-unavailable]')).toBe(false)
    // The confirmation is still asked for, and still gates the email.
    expect(shown('[data-invoice-composer-confirm-label]')).toBe(true)
    submit('[data-invoice-composer-form]')
    expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
      'Confirm the recipients before sending this invoice email.',
    )
    expect(calls).toEqual([])

    box('[data-invoice-composer-confirm]').click()
    submit('[data-invoice-composer-form]')
    await vi.waitFor(() => expect(calls).toEqual(['send', 'deliver']))
    expect(api.deliverInvoiceEmail).toHaveBeenCalledWith(
      7,
      expect.any(String),
      expect.objectContaining({
        recipients: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        cc: [
          { name: 'Pat Example', email: 'pat@northwind.example' },
          { name: '', email: 'lee@northwind.example' },
        ],
        confirmed: true,
      }),
      expect.any(AbortSignal),
    )
  })

  it('[browser] names recording alone on the button, and warns that nothing will be emailed', async () => {
    const { api, calls } = sending({ getInvoiceEmailDefaults: vi.fn(async () => defaults()) })
    await openWithDefaults(api)
    box('[data-invoice-composer-deliver-toggle]').click()
    expect(submitLabel()).toBe('Mark as sent (no email)')
    expect(shown('[data-invoice-composer-no-email]')).toBe(true)
    expect(document.querySelector('[data-invoice-composer-no-email]')?.textContent).toBe(
      'Nothing will be emailed — this only records the invoice as sent.',
    )
    // No email, so no recipients to confirm.
    expect(shown('[data-invoice-composer-confirm-label]')).toBe(false)

    submit('[data-invoice-composer-form]')
    await vi.waitFor(() => expect(calls).toEqual(['send']))
    expect(api.deliverInvoiceEmail).not.toHaveBeenCalled()
  })

  it('[browser] opens recording alone, and says why, where the organization cannot send email', async () => {
    const { api, calls } = sending({
      getInvoiceEmailDefaults: vi.fn(async () =>
        defaults({
          delivery: {
            available: false,
            code: 'sender_identity_missing',
            message: 'Configure and verify an organization sender before sending.',
          },
        }),
      ),
    })
    await openWithDefaults(api)
    expect(box('[data-invoice-composer-deliver-toggle]').checked).toBe(false)
    expect(submitLabel()).toBe('Mark as sent (no email)')
    expect(shown('[data-invoice-composer-no-email]')).toBe(true)
    expect(shown('[data-invoice-composer-delivery-unavailable]')).toBe(true)
    expect(document.querySelector('[data-invoice-composer-delivery-unavailable]')?.textContent).toBe(
      'Email delivery is unavailable. Configure and verify an organization sender before sending.',
    )
    // Still the operator's to tick, with the reason left beside it.
    box('[data-invoice-composer-deliver-toggle]').click()
    expect(submitLabel()).toBe('Send and deliver')
    expect(shown('[data-invoice-composer-no-email]')).toBe(false)
    expect(shown('[data-invoice-composer-delivery-unavailable]')).toBe(true)
    expect(calls).toEqual([])
  })

  it('[browser] opens recording alone where this build cannot deliver email at all', async () => {
    const { api } = sending()
    delete api.deliverInvoiceEmail
    await openComposer(api)
    expect(box('[data-invoice-composer-deliver-toggle]').checked).toBe(false)
    expect(submitLabel()).toBe('Mark as sent (no email)')
    expect(shown('[data-invoice-composer-no-email]')).toBe(true)
  })

  it('[browser] keeps the delivery box the operator set before the defaults arrived', async () => {
    let answer: (value: InvoiceEmailDefaults) => void = () => undefined
    const { api } = sending({
      getInvoiceEmailDefaults: vi.fn(
        () =>
          new Promise<InvoiceEmailDefaults>((resolve) => {
            answer = resolve
          }),
      ),
    })
    await openComposer(api)
    const toggle = box('[data-invoice-composer-deliver-toggle]')
    expect(toggle.checked).toBe(true)
    // The email taken off before the server's answer lands: the answer says it
    // could go, and the operator's choice still stands.
    toggle.click()
    answer(defaults())
    await vi.waitFor(() =>
      expect(field('[data-invoice-composer-recipients]').value).toBe(
        'Accounts Payable <ap@northwind.example>',
      ),
    )
    expect(toggle.checked).toBe(false)
    expect(submitLabel()).toBe('Mark as sent (no email)')
  })

  it("[e2e:invoice-email] sends what the client's rules attach, with nothing ticked by hand", async () => {
    // Delivery opening ticked is half of it. What goes with the email has to
    // be what the client's sending rules choose, without anybody touching it.
    const { api, calls } = sending({
      getInvoiceEmailDefaults: vi.fn(async () => defaults()),
      getInvoiceDocumentPreference: vi.fn(async () =>
        preference({
          client_attach_pdf: true,
          effective: true,
          client_append_pdfs: true,
          effective_append_pdfs: true,
        }),
      ),
    })
    await openWithDefaults(api)
    const pdf = box('[data-invoice-composer-attach-pdf]')
    expect(pdf.checked).toBe(true)
    expect(pdf.disabled).toBe(false)
    expect(box('[data-invoice-composer-append]').checked).toBe(true)
    box('[data-invoice-composer-confirm]').click()
    submit('[data-invoice-composer-form]')
    // Nothing differs from what the invoice does anyway, so nothing is saved
    // over the client's rules.
    await vi.waitFor(() => expect(calls).toEqual(['send', 'deliver']))
    expect(api.setInvoiceDocumentPreference).not.toHaveBeenCalled()
    expect(api.transitionInvoice).toHaveBeenCalledWith(
      7,
      expect.any(String),
      expect.objectContaining({ command: 'send', attach_pdf: true }),
      expect.any(AbortSignal),
    )
  })

  it('[browser] offers no attachments where the build has no route for them', async () => {
    const { api } = sending()
    delete api.getInvoiceDocumentPreference
    delete api.setInvoiceDocumentPreference
    await createInvoicePaymentController(api).activate(identity(1), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    expect(document.querySelector<HTMLElement>('[data-invoice-composer-attachments]')?.hidden).toBe(
      true,
    )
  })
})
