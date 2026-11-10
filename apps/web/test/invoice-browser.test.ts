/** @vitest-environment happy-dom */

import { EzactoApiError, type Attachment, type Invoice, type InvoicePayment, type InvoicePaymentInput, type InvoiceTransitionInput } from '@conflict-hq/ezacto-client'

import { describe, expect, it, vi } from 'vitest'
import { createInvoicePaymentController, setInvoiceClientNames } from '../src/invoices/browser.js'
import { type InvoicePaymentApi } from '../src/invoices/model.js'

import { leavePageNotice } from '../src/page-notice.js'

import { contrastRatio, defaultTheme, themeManifest, webAssets } from '../src/index.js'

import { timestamp, identity, invoice, payment, line, deferred, renderDetail, applyPrintRules, painted, submit } from './invoice-browser-fixtures.js'

describe('invoice payment controller', () => {
  it('[browser] makes no attachment requests when storage is disabled on the instance', async () => {
    renderDetail()
    document.documentElement.setAttribute('data-attachments-unavailable', '')
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () => invoice('NO-STORAGE')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      listInvoiceAttachments: vi.fn(async () => []),
      uploadInvoiceAttachment: vi.fn(),
    }
    await createInvoicePaymentController(api).activate(identity(1), new AbortController().signal, () => false)
    expect(api.getInvoice).toHaveBeenCalled()
    expect(api.listInvoiceAttachments).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-attachment-status]')?.textContent).toBe(
      'File attachments are not enabled on this instance.',
    )
    expect(document.querySelector<HTMLElement>('[data-invoice-attachment-form]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-invoice-attachment-readonly]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-invoice-attachment-demo]')!.hidden).toBe(true)
    const input = document.querySelector<HTMLInputElement>('[data-invoice-attachment-form] input[name="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['owned'], 'owned.txt', { type: 'text/plain' })] })
    submit('[data-invoice-attachment-form]')
    expect(api.uploadInvoiceAttachment).not.toHaveBeenCalled()
    expect(api.listInvoiceAttachments).not.toHaveBeenCalled()
  })

  it('[browser] gives Send back once an upload settles, even if a side read repainted the controls during it', async () => {
    // Issue 745. The detail page reads QuickBooks, reminders and attachments
    // beside the invoice and repaints the controls as each answers. One that
    // answers while an upload is in flight paints them locked -- correctly --
    // and the upload has to repaint them when it settles, or Send stays
    // disabled until the page is reloaded. A slow runner landed the read in
    // that window and the browser suite timed out on a disabled Send.
    renderDetail()
    let rejectQuickBooks: (error: unknown) => void = () => undefined
    const quickBooksRead = new Promise<never>((_resolve, reject) => {
      rejectQuickBooks = reject
    })
    const upload = deferred<Attachment>()
    const file: Attachment = {
      id: 31,
      name: 'scope.pdf',
      content_hash: 'b'.repeat(64),
      byte_size: 5,
      content_type: 'application/pdf',
      uploaded_by_user_id: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }
    let attached: readonly Attachment[] = []
    const api: Partial<InvoicePaymentApi> = {
      getInvoice: vi.fn(async () => invoice('UPLOAD-1')),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
      listInvoiceAttachments: vi.fn(async () => attached),
      getInvoiceQuickBooks: vi.fn(() => quickBooksRead),
      uploadInvoiceAttachment: vi.fn(() => upload.promise),
    }
    const controller = createInvoicePaymentController(api)
    await controller.activate(identity(1), new AbortController().signal, () => false)
    const send = document.querySelector<HTMLButtonElement>('[data-invoice-send]')!
    const status = document.querySelector<HTMLElement>('[data-invoice-attachment-status]')!
    await vi.waitFor(() => expect(status.textContent).toBe('0 files attached.'))
    expect(send.hidden).toBe(false)
    expect(send.disabled).toBe(false)

    const input = document.querySelector<HTMLInputElement>(
      '[data-invoice-attachment-form] input[name="file"]',
    )!
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['%PDF-'], 'scope.pdf', { type: 'application/pdf' })],
    })
    submit('[data-invoice-attachment-form]')
    await vi.waitFor(() => expect(api.uploadInvoiceAttachment).toHaveBeenCalledTimes(1))
    expect(status.getAttribute('aria-busy')).toBe('true')

    // The side read answers mid-upload: a deployment without the QuickBooks
    // routes, which repaints the controls while the upload holds them.
    rejectQuickBooks(
      new EzactoApiError(404, { error: { code: 'not_found', message: 'Not found', fields: [] } }, null),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(send.disabled).toBe(true)

    attached = [file]
    upload.resolve(file)
    await vi.waitFor(() => expect(status.textContent).toBe('1 file attached.'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(send.disabled).toBe(false)
    expect(status.getAttribute('aria-busy')).toBe('false')
  })

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
    expect(pageStatus.getAttribute('aria-busy')).toBe('true')
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
    expect(pageStatus.getAttribute('aria-busy')).toBe('false')
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

  it('[browser #949] says which rounding the invoiced projects are under today', async () => {
    renderDetail()
    const projects: Record<number, Record<string, unknown>> = {
      1: { id: 1, name: 'Northpeak', time_rounding_mode: 'up', time_rounding_minutes: 15 },
      2: { id: 2, name: 'Acme', time_rounding_mode: null, time_rounding_minutes: null },
      // Read without commercial authority: no rule to speak of, so none is guessed.
      3: { id: 3, name: 'Hidden' },
    }
    const getDirectoryProject = vi.fn(async (id: number) => projects[id] as never)
    await createInvoicePaymentController({
      findInvoiceByNumber: vi.fn(async () => null),
      getInvoice: vi.fn(async () =>
        invoice('ROUNDED', {
          line_items: [
            line({ id: 1, project_id: 1 }),
            line({ id: 2, project_id: 1 }),
            line({ id: 3, project_id: 2 }),
            line({ id: 4, project_id: 3 }),
            line({ id: 5, project_id: null }),
          ],
        }),
      ),
      getDirectoryProject,
      getTimeEntrySettings: vi.fn(async () => ({ time_rounding: { mode: 'down' as const, minutes: 30 as const } })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }).activate(identity(1), new AbortController().signal, () => false)

    const fact = document.querySelector<HTMLElement>('[data-invoice-rounding-fact]')!
    await vi.waitFor(() => expect(fact.hidden).toBe(false))
    expect(document.querySelector('[data-invoice-detail-rounding]')?.textContent).toBe(
      'Northpeak: rounded up to 15 min (project setting); Acme: rounded down to 30 min (organization setting)',
    )
    // Each project is read once however many lines it has.
    expect(getDirectoryProject).toHaveBeenCalledTimes(3)
  })

  it('[browser #1351] keeps operating facts outside the invoice and off paper', async () => {
    renderDetail()
    await createInvoicePaymentController({
      getInvoice: vi.fn(async () => invoice('CLIENT-COPY', { line_items: [line()] })),
      getDirectoryProject: vi.fn(async () => ({ id: 1, name: 'Northpeak', time_rounding_mode: null, time_rounding_minutes: null }) as never),
      getTimeEntrySettings: vi.fn(async () => ({ time_rounding: { mode: 'exact' as const, minutes: 15 as const } })),
      getInvoiceQuickBooks: vi.fn(async () => ({ connected: false, invoice: null, payments: [], last_outcome: null })),
      getInvoiceReminderPreference: vi.fn(async () => ({ invoice_id: 7, reminders: null, organization_reminder_policy: { first_after_days: 3, every_days: 7 }, effective: true, next_reminder_at: '2026-09-18T00:00:00.000Z' })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }).activate(identity(1), new AbortController().signal, () => false)
    const article = document.querySelector<HTMLElement>('[data-invoice-document]')!
    for (const selector of ['[data-invoice-rounding-fact]', '[data-invoice-quickbooks-fact]', '[data-invoice-reminders-fact]']) {
      const fact = document.querySelector<HTMLElement>(selector)!
      await vi.waitFor(() => expect(fact.hidden).toBe(false))
      expect(article.contains(fact)).toBe(false)
      expect(fact.closest('[data-invoice-internal]')).not.toBeNull()
    }
    expect(article.textContent).not.toContain('organization setting')
    expect(article.textContent).not.toContain('Not connected')
    expect(article.textContent).not.toContain('Send payment reminders')
    expect(document.querySelector('[data-invoice-detail-total]')?.textContent).toBe('$10.00')
    expect(document.querySelector('[data-invoice-reminders-toggle]')).not.toBeNull()
    applyPrintRules()
    expect(painted('[data-invoice-internal]').display).toBe('none')
    expect(painted('[data-invoice-document]').display).not.toBe('none')
    expect(painted('[data-invoice-detail-total]').display).not.toBe('none')
  })

  it('[browser #949] leaves the rounding row out when there is nothing to say', async () => {
    renderDetail()
    await createInvoicePaymentController({
      findInvoiceByNumber: vi.fn(async () => null),
      getInvoice: vi.fn(async () => invoice('PLAIN', { line_items: [line({ project_id: null })] })),
      getDirectoryProject: vi.fn(async () => {
        throw new Error('not asked')
      }),
      getTimeEntrySettings: vi.fn(async () => ({ time_rounding: { mode: 'exact' as const, minutes: 15 as const } })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => []),
    }).activate(identity(1), new AbortController().signal, () => false)
    expect(document.querySelector<HTMLElement>('[data-invoice-document]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-invoice-rounding-fact]')?.hidden).toBe(true)
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
