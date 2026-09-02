/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type Invoice,
  type InvoicePayment,
  type Whoami,
} from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createInvoicePaymentController } from '../src/invoices/browser.js'
import type { InvoicePaymentApi } from '../src/invoices/model.js'
import { renderAppShell } from '../src/shell/render.js'

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

const deferred = <Value>() => {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve: (value: Value) => resolve?.(value) }
}

const renderDetail = (): void => {
  window.history.replaceState(null, '', '/invoices/7')
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
          : invoice('SECOND', { notes: 'Only second user can see this' }),
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
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Open')
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
})
