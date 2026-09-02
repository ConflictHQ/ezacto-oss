/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type Invoice,
  type InvoiceLine,
  type InvoiceLineInput,
  type InvoiceLineUpdateInput,
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

  it('[e2e:invoice-lines] retries, adds, edits, and deletes exact free-form lines', async () => {
    renderDetail()
    let currentInvoice = invoice('LINES', {
      version: 1,
      amount_cents: 0,
      due_amount_cents: 0,
      line_items: [],
    })
    let createAttempts = 0
    const createInvoiceLine = vi.fn(
      async (_invoiceId: number, _commandId: string, input: InvoiceLineInput) => {
        createAttempts += 1
        if (createAttempts === 1) throw new Error('network unavailable')
        currentInvoice = {
          ...currentInvoice,
          version: 2,
          amount_cents: 11,
          due_amount_cents: 11,
          line_items: [
            line({
              kind: input.kind,
              description: input.description ?? null,
              position: input.position,
              quantity: input.quantity,
              unit_price_cents: input.unit_price_cents,
              amount_cents: 11,
              taxed: input.taxed ?? false,
              taxed2: input.taxed2 ?? false,
              project_id: input.project_id ?? null,
            }),
          ],
        }
        return currentInvoice
      },
    )
    const updateInvoiceLine = vi.fn(
      async (
        _invoiceId: number,
        _lineId: number,
        _commandId: string,
        input: InvoiceLineUpdateInput,
      ) => {
        currentInvoice = {
          ...currentInvoice,
          version: 3,
          amount_cents: 308,
          due_amount_cents: 308,
          line_items: [
            line({
              kind: input.kind,
              description: input.description ?? null,
              position: input.position,
              quantity: input.quantity,
              unit_price_cents: input.unit_price_cents,
              amount_cents: 308,
              taxed: input.taxed ?? false,
              taxed2: input.taxed2 ?? false,
              project_id: input.project_id ?? null,
              updated_at: '2026-08-29T12:00:00.000Z',
            }),
          ],
        }
        return currentInvoice
      },
    )
    const deleteInvoiceLine = vi.fn(async () => {
      currentInvoice = {
        ...currentInvoice,
        version: 4,
        amount_cents: 0,
        due_amount_cents: 0,
        line_items: [],
      }
      return currentInvoice
    })
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      createInvoiceLine,
      updateInvoiceLine,
      deleteInvoiceLine,
    }
    const controller = createInvoicePaymentController(api)
    await controller.activate(identity(1), new AbortController().signal, () => false)

    const add = document.querySelector<HTMLButtonElement>('[data-invoice-line-add]')!
    const editor = document.querySelector<HTMLDialogElement>('[data-invoice-line-dialog]')!
    add.click()
    editor.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(createInvoiceLine).not.toHaveBeenCalled()
    add.click()
    editor.querySelector<HTMLButtonElement>('[data-dialog-close][aria-label]')!.click()
    expect(createInvoiceLine).not.toHaveBeenCalled()

    add.click()
    const kind = document.querySelector<HTMLInputElement>('[data-invoice-line-kind]')!
    const description = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-line-description]',
    )!
    const quantity = document.querySelector<HTMLInputElement>('[data-invoice-line-quantity]')!
    const rate = document.querySelector<HTMLInputElement>('[data-invoice-line-rate]')!
    kind.value = 'Consulting'
    description.value = 'Exact tenth-hour adjustment'
    quantity.value = '0.1'
    rate.value = '1.05'
    rate.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('[data-invoice-line-preview]')?.textContent).toBe('$0.11')
    submit('[data-invoice-line-form]')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-line-result]')?.textContent).toBe(
        'network unavailable',
      ),
    )
    submit('[data-invoice-line-form]')
    await vi.waitFor(() => expect(editor.open).toBe(false))
    expect(createInvoiceLine).toHaveBeenCalledTimes(2)
    expect(createInvoiceLine.mock.calls[0]?.[1]).toBe(createInvoiceLine.mock.calls[1]?.[1])
    expect(createInvoiceLine.mock.calls[1]?.[2]).toEqual({
      expected_version: 1,
      position: 0,
      kind: 'Consulting',
      description: 'Exact tenth-hour adjustment',
      quantity: 0.1,
      unit_price_cents: 105,
      taxed: false,
      taxed2: false,
    })
    expect(document.querySelector('[data-invoice-detail-total]')?.textContent).toBe('$0.11')

    document.querySelector<HTMLButtonElement>('[data-invoice-line-edit="21"]')!.click()
    quantity.value = '1.5'
    rate.value = '2.05'
    description.value = 'Updated adjustment'
    description.dispatchEvent(new Event('input', { bubbles: true }))
    submit('[data-invoice-line-form]')
    await vi.waitFor(() => expect(editor.open).toBe(false))
    expect(updateInvoiceLine).toHaveBeenCalledWith(
      7,
      21,
      expect.stringMatching(/^web\.invoice\.line\.update:/u),
      {
        expected_version: 2,
        expected_updated_at: timestamp,
        position: 0,
        kind: 'Consulting',
        description: 'Updated adjustment',
        quantity: 1.5,
        unit_price_cents: 205,
        taxed: false,
        taxed2: false,
        project_id: null,
      },
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-invoice-detail-total]')?.textContent).toBe('$3.08')

    const openDelete = (): void =>
      document.querySelector<HTMLButtonElement>('[data-invoice-line-delete="21"]')!.click()
    openDelete()
    const confirmation = document.querySelector<HTMLDialogElement>(
      '[data-invoice-line-delete-dialog]',
    )!
    confirmation.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(deleteInvoiceLine).not.toHaveBeenCalled()
    openDelete()
    confirmation.querySelector<HTMLButtonElement>('[data-dialog-close][aria-label]')!.click()
    expect(deleteInvoiceLine).not.toHaveBeenCalled()
    openDelete()
    submit('[data-invoice-line-delete-form]')
    await vi.waitFor(() => expect(confirmation.open).toBe(false))
    expect(deleteInvoiceLine).toHaveBeenCalledWith(
      7,
      21,
      expect.stringMatching(/^web\.invoice\.line\.delete:/u),
      {
        expected_version: 3,
        expected_updated_at: '2026-08-29T12:00:00.000Z',
      },
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-invoice-detail-total]')?.textContent).toBe('$0.00')
    expect(document.querySelector('[data-invoice-detail-lines]')?.textContent).toContain(
      'no line items',
    )
  })

  it('[conflict] refetches a changed line and preserves the pending form values', async () => {
    renderDetail()
    let currentInvoice = invoice('LINE-CONFLICT', { line_items: [line()] })
    let attempts = 0
    const commandIds: string[] = []
    const updateInvoiceLine = vi.fn(
      async (_invoiceId: number, _lineId: number, commandId: string, input: InvoiceLineUpdateInput) => {
        attempts += 1
        commandIds.push(commandId)
        if (attempts === 1) {
          currentInvoice = {
            ...currentInvoice,
            version: 2,
            line_items: [line({ updated_at: '2026-08-29T12:00:00.000Z' })],
          }
          throw new EzactoApiError(
            409,
            {
              error: {
                code: 'trigger_row_conflict',
                message: 'server conflict',
                fields: [],
              },
            },
            null,
          )
        }
        expect(input.expected_version).toBe(2)
        expect(input.expected_updated_at).toBe('2026-08-29T12:00:00.000Z')
        expect(input.project_id).toBe(1)
        currentInvoice = { ...currentInvoice, version: 3 }
        return currentInvoice
      },
    )
    const controller = createInvoicePaymentController({
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      updateInvoiceLine,
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-invoice-line-edit="21"]')!.click()
    const description = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-line-description]',
    )!
    description.value = 'Preserve my line correction'
    description.dispatchEvent(new Event('input', { bubbles: true }))
    submit('[data-invoice-line-form]')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-line-result]')?.textContent).toContain(
        'Latest values are loaded',
      ),
    )
    expect(description.value).toBe('Preserve my line correction')
    submit('[data-invoice-line-form]')
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>('[data-invoice-line-dialog]')?.open).toBe(
        false,
      ),
    )
    expect(commandIds).toHaveLength(2)
    expect(commandIds[0]).not.toBe(commandIds[1])
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

  it('[reliability] never repeats a committed line write when detail refresh fails', async () => {
    renderDetail()
    let committed = false
    let loads = 0
    const initial = invoice('INITIAL', { amount_cents: 0, due_amount_cents: 0, line_items: [] })
    const refreshed = invoice('REFRESHED', {
      version: 2,
      amount_cents: 100,
      due_amount_cents: 100,
      line_items: [line({ amount_cents: 100, unit_price_cents: 100 })],
    })
    const getInvoice = vi.fn(async () => {
      loads += 1
      if (loads === 2) throw new Error('refresh unavailable')
      return committed ? refreshed : initial
    })
    const createInvoiceLine = vi.fn(async () => {
      committed = true
      return refreshed
    })
    const controller = createInvoicePaymentController({
      getInvoice,
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      createInvoiceLine,
    })
    await controller.activate(identity(1), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-invoice-line-add]')!.click()
    document.querySelector<HTMLInputElement>('[data-invoice-line-rate]')!.value = '1.00'
    submit('[data-invoice-line-form]')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-line-status]')?.textContent).toContain(
        'will not be submitted again',
      ),
    )
    expect(createInvoiceLine).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-line-add]')?.disabled).toBe(
      true,
    )
    submit('[data-invoice-line-form]')
    await Promise.resolve()
    expect(createInvoiceLine).toHaveBeenCalledTimes(1)

    document.querySelector<HTMLButtonElement>('[data-invoice-detail-retry]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-number]')?.textContent).toBe('REFRESHED'),
    )
    expect(createInvoiceLine).toHaveBeenCalledTimes(1)
  })

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
