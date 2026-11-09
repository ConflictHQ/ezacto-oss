/** @vitest-environment happy-dom */

import { EzactoApiError, type InvoiceTransitionInput } from '@conflict-hq/ezacto-client'

import { describe, expect, it, vi } from 'vitest'
import { createInvoicePaymentController } from '../src/invoices/browser.js'

import { type InvoiceDocumentPreference, type InvoiceEmailDefaults, type InvoicePaymentApi } from '../src/invoices/model.js'





import { timestamp, identity, invoice, line, renderDetail, submit } from './invoice-browser-fixtures.js'


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
  const sending = (overrides: Partial<InvoicePaymentApi> = {}, demo = false) => {
    renderDetail(undefined, demo)
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
    time_zone: 'America/Costa_Rica',
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

  const mismatchReview = (): Awaited<ReturnType<NonNullable<InvoicePaymentApi['getInvoiceHoursReconciliation']>>> => ({
    invoice_id: 7, invoice_version: 1, invoice_state: 'draft', hours_version: 'a'.repeat(64),
    linked_seconds: 7200, billed_seconds: 7200, difference_seconds: 0, status: 'matched',
    tolerance_seconds: 36, total_tolerance_seconds: 72, comparison_complete: true, has_mismatch: true,
    not_compared_entry_ids: [], projects: [], not_compared: [], entries: [],
    lines: [
      {line_id: 1, project_id: 1, entry_ids: [1], linked_seconds: 5400, billed_seconds: 3600, difference_seconds: 1800, status: 'billed_below_linked'},
      {line_id: 2, project_id: 1, entry_ids: [2], linked_seconds: 1800, billed_seconds: 3600, difference_seconds: -1800, status: 'billed_above_linked'},
    ],
  })

  it('[browser #924] warns before sending even when opposite line differences cancel out', async () => {
    let resolve!: (review: ReturnType<typeof mismatchReview>) => void
    const review = new Promise<ReturnType<typeof mismatchReview>>(done => { resolve = done })
    const getInvoiceHoursReconciliation = vi.fn(() => review)
    const { api, calls } = sending({ getInvoiceHoursReconciliation })
    await openComposer(api)
    expect(box('[data-invoice-composer-submit]').disabled).toBe(true)
    deliverTo('ap@example.com')
    submit('[data-invoice-composer-form]')
    expect(calls).toEqual([])
    resolve(mismatchReview())
    await vi.waitFor(() => expect(box('[data-invoice-composer-submit]').disabled).toBe(false))
    const warning = document.querySelector<HTMLElement>('[data-invoice-composer-hours-warning]')!
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain('linked 2.00 h · billed 2.00 h')
    expect(warning.textContent).toContain('At least one line differs')
    expect(getInvoiceHoursReconciliation).toHaveBeenCalledWith(7, expect.any(AbortSignal))
  })

  it('[browser #924] leaves an explicit warning when hours cannot be compared', async () => {
    const { api } = sending({ getInvoiceHoursReconciliation: vi.fn(async () => { throw new Error('offline') }) })
    await openComposer(api)
    await vi.waitFor(() => expect(document.querySelector('[data-invoice-composer-hours-warning]')?.textContent).toContain('could not be compared'))
    expect(box('[data-invoice-composer-submit]').disabled).toBe(false)
  })

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

  it('[e2e:invoice-email] records the send weekday in the organization zone, not a literal token (issue 925)', async () => {
    const { api } = sending({ getInvoiceEmailDefaults: vi.fn(async () => defaults()) })
    await openWithDefaults(api)
    box('[data-invoice-composer-confirm]').click()
    document.querySelector<HTMLInputElement>('[data-invoice-composer-subject]')!.value =
      'Happy %send_weekday%!'
    submit('[data-invoice-composer-form]')
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: 'America/Costa_Rica',
    }).format(new Date())
    await vi.waitFor(() =>
      expect(api.transitionInvoice).toHaveBeenCalledWith(
        7,
        expect.any(String),
        expect.objectContaining({ subject: `Happy ${weekday}!` }),
        expect.any(AbortSignal),
      ),
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
    const getInvoiceHoursReconciliation = vi.fn(async () => mismatchReview())
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
      getInvoiceHoursReconciliation,
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
    expect(getInvoiceHoursReconciliation).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-invoice-composer-hours-warning]')?.textContent).toContain('Hours report warning')
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

  it('[security] on the public demo, says its mail reaches only approved addresses, and takes no file', async () => {
    // Issue 931. The Worker delivers the demo's mail only to the domains the
    // deployment approves and refuses every upload; the screen says both
    // before anyone acts on it -- and never which domains those are.
    const sendInvoiceEmailPreview = vi.fn(async () => ({
      to: [{ name: 'Ana Example', email: 'ana@example.com' }],
    }))
    const { api } = sending(
      {
        getInvoiceEmailDefaults: vi.fn(async () => defaults()),
        previewInvoiceEmail: vi.fn(),
        sendInvoiceEmailPreview,
        uploadInvoiceAttachment: vi.fn(),
      },
      true,
    )
    await openWithDefaults(api)
    const mail = document.querySelector<HTMLElement>('[data-invoice-composer-demo]')!
    expect(mail.hidden).toBe(false)
    expect(mail.textContent).toBe(
      'On the public demo, email is only delivered to approved addresses.',
    )
    expect(document.querySelector<HTMLElement>('[data-invoice-attachment-form]')!.hidden).toBe(true)
    const note = document.querySelector<HTMLElement>('[data-invoice-attachment-demo]')!
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe('Uploading a file: not available on the public demo.')

    document.querySelector<HTMLButtonElement>('[data-invoice-composer-preview-send]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-preview-result]')?.textContent).toBe(
        'A preview for ana@example.com, stamped PREVIEW, was recorded. On the public demo, email is only delivered to approved addresses. Nothing was sent to the client.',
      ),
    )
  })

  it('[security] on the public demo, a send says its mail reaches only approved addresses', async () => {
    const { api, calls } = sending({}, true)
    await openComposer(api)
    deliverTo('ap@example.test')
    submit('[data-invoice-composer-form]')
    await vi.waitFor(() => expect(calls).toEqual(['send', 'deliver']))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toContain(
        'Sent. On the public demo, email is only delivered to approved addresses. Settings › Deliveries shows what went.',
      ),
    )
  })

  it('[browser] keeps both notes out of view anywhere but the demo', async () => {
    const { api } = sending({
      getInvoiceEmailDefaults: vi.fn(async () => defaults()),
      uploadInvoiceAttachment: vi.fn(),
    })
    await openWithDefaults(api)
    expect(document.querySelector<HTMLElement>('[data-invoice-composer-demo]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-invoice-attachment-demo]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-invoice-attachment-form]')!.hidden).toBe(false)
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
