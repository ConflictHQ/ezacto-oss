/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  EzactoApiError,
  authenticationError,
  browserApi,
  identity,
  invoice,
  invoiceMessage,
  invoicePayment,
  mountShell,
  renderBrowserShell,
  resource,
  secondIdentity,
  timeEntry,
  timestamp,
  type InvoiceMessage,
  type InvoicePayment,
  type InvoicePaymentInput,
  type InvoicePaymentUpdateInput,
  type InvoiceTransitionInput,
  type ShellApi,
  type Whoami,
} from './support/shell-harness.js'

describe('invoice generation browser behavior', () => {
  it('[unit] loads and operates the global running timer on the invoice page', async () => {
    renderBrowserShell({ view: 'invoice-generation' })
    const api = browserApi()
    api.entries.push(
      timeEntry(3, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-28',
        notes: 'Running from the invoice workspace',
      }),
    )

    await mountShell(api)

    const timerChip = document.querySelector<HTMLButtonElement>('[data-timer-chip]')!
    await vi.waitFor(() => expect(timerChip.textContent).toContain('Northpeak / Development'))
    timerChip.click()
    document.querySelector<HTMLButtonElement>('[data-stop-timer]')!.click()
    await vi.waitFor(() => expect(api.stopTimeEntry).toHaveBeenCalledWith(3, expect.anything()))
  })

  it('[browser] bills the period the wizard stepped to, and refuses a half-typed one', async () => {
    // The fieldset used to carry two `required` date inputs, so "last month"
    // meant typing four digits and the browser itself refused an empty range.
    // The control is the reports card's, and the emptiness check is now ours.
    renderBrowserShell({ view: 'invoice-generation' })
    const generateInvoice = vi
      .fn<NonNullable<ShellApi['generateInvoice']>>()
      .mockResolvedValue(invoice(21))
    const api: ShellApi = {
      ...browserApi(),
      listClients: async () => ({
        data: [resource(11, 'Northwind Freight')],
        page: { next_cursor: null },
      }),
      listProjects: async () => ({
        data: [{ ...resource(1, 'Northpeak'), client_id: 11 }],
        page: { next_cursor: null },
      }),
      generateInvoice,
    }
    await mountShell(api)

    const wizard = document.querySelector<HTMLFormElement>('[data-invoice-generation-form]')!
    const period = wizard.querySelector<HTMLElement>('[data-invoice-period]')!
    // Counted first, because every assertion below reads one of these.
    expect(period.querySelectorAll('.period-step')).toHaveLength(2)
    const from = period.querySelector<HTMLInputElement>('[data-period-from]')!
    const to = period.querySelector<HTMLInputElement>('[data-period-to]')!

    // Month-to-date, exactly as the wizard has always opened, presented as the
    // custom range it is rather than silently widened to a whole month.
    await vi.waitFor(() => expect(from.value).not.toBe(''))
    expect(to.value).toBe(from.value.slice(0, 8) + to.value.slice(8))
    expect(from.value.slice(8)).toBe('01')
    expect(period.querySelector<HTMLSelectElement>('[data-period-kind]')!.value).toBe('custom')

    // Scoped to the wizard: `[name="project"]` unqualified is the time-entry
    // dialog's project field, which is present in the same shell and would let
    // every assertion below pass against a wizard that offered no projects.
    // happy-dom does not adopt the first option as the selection the way a real
    // browser does, so the client is chosen here rather than assumed.
    const clientSelect = wizard.querySelector<HTMLSelectElement>('[data-invoice-client]')!
    await vi.waitFor(() => expect(clientSelect.options.length).toBe(1))
    clientSelect.value = '11'
    clientSelect.dispatchEvent(new Event('change'))
    await vi.waitFor(() =>
      expect(wizard.querySelectorAll('[data-invoice-projects] [name="project"]').length)
        .toBeGreaterThan(0),
    )
    wizard.querySelector<HTMLInputElement>('[data-invoice-projects] [name="project"]')!.checked =
      true

    // An empty range no longer reaches the command: nothing marks these inputs
    // required, because a half-typed custom range is a normal state to be in.
    from.value = ''
    wizard.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(generateInvoice).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-generation-result]')?.textContent).toBe(
      'Choose a client, date range, and at least one project.',
    )

    // A whole month, one arrow back from the month it opened on.
    period.querySelector<HTMLSelectElement>('[data-period-kind]')!.value = 'month'
    period
      .querySelector<HTMLSelectElement>('[data-period-kind]')!
      .dispatchEvent(new Event('change'))
    period.querySelector<HTMLButtonElement>('[data-period-previous]')!.click()
    const billed = { from: from.value, to: to.value }
    wizard.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(generateInvoice).toHaveBeenCalledTimes(1))
    expect(generateInvoice.mock.calls[0]![1]).toMatchObject(billed)
    // A whole month, and the one before the month the wizard opened on.
    expect(billed.from.slice(8)).toBe('01')
    expect(billed.from < billed.to).toBe(true)
  })
})

describe('invoice browse browser behavior', () => {
  it('[acceptance] opens on what is outstanding and asks the server for it', async () => {
    // 739 invoices, 9 of them open. The list opened on all 739 newest-first,
    // and the endpoint had no state parameter, so narrowing it on the client
    // would have narrowed the loaded page only -- 50 of 739 -- and reported a
    // count over that slice as if it were the account.
    renderBrowserShell({ view: 'invoice-list' })
    const listInvoices = vi.fn(async (_cursor, _signal, _perPage, states) => ({
      data: (states as readonly string[] | undefined)?.includes('paid')
        ? [invoice(9, { state: 'paid' })]
        : [invoice(7, { state: 'open' })],
      page: { next_cursor: null },
    }))
    const api: ShellApi = { ...browserApi(), listInvoices }

    await mountShell(api)

    // Outstanding is draft plus open. Paid is settled; closed is written off
    // or cancelled, which is settled by another name.
    expect(listInvoices).toHaveBeenNthCalledWith(1, undefined, expect.anything(), undefined, [
      'draft',
      'open',
    ])
    expect(
      document.querySelector('[data-invoice-filter="outstanding"]')?.getAttribute('aria-pressed'),
    ).toBe('true')

    document.querySelector<HTMLButtonElement>('[data-invoice-filter="paid"]')!.click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(2))
    expect(listInvoices).toHaveBeenNthCalledWith(2, undefined, expect.anything(), undefined, [
      'paid',
    ])
    await vi.waitFor(() =>
      expect(document.querySelector('tbody tr[data-row-key="9"]')).not.toBeNull(),
    )
    // A different question is a different traversal: the rows that answered
    // the old one do not stay on the page beside the new ones.
    expect(document.querySelector('tbody tr[data-row-key="7"]')).toBeNull()

    // All sends no state at all, which is the absent parameter.
    document.querySelector<HTMLButtonElement>('[data-invoice-filter="all"]')!.click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(3))
    expect(listInvoices).toHaveBeenNthCalledWith(
      3,
      undefined,
      expect.anything(),
      undefined,
      undefined,
    )
  })

  it('[acceptance] loads a cursor page and appends the next invoice page', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi
      .fn()
      .mockResolvedValueOnce({
        data: [invoice(7)],
        page: { next_cursor: 'next-page' },
      })
      .mockResolvedValueOnce({
        data: [invoice(8, { state: 'open' })],
        page: { next_cursor: null },
      })
    // "Client #11" is an internal identifier on a page a client can be sent.
    const listClients: ShellApi['listClients'] = async () => ({
      data: [resource(11, 'Northwind Freight')],
      page: { next_cursor: null },
    })
    const api: ShellApi = { ...base, listInvoices, listClients }

    await mountShell(api)

    const first = document.querySelector<HTMLElement>('tbody tr[data-row-key="7"]')!
    expect(first.textContent).toContain('Invoice INV-7')
    await vi.waitFor(() =>
      expect(
        document.querySelector('tbody tr[data-row-key="7"] td[data-column="client"]')
          ?.textContent,
      ).toBe('Northwind Freight'),
    )
    expect(first.textContent).toContain('$82.50')
    expect(first.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(
      '/invoices/7',
    )
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '1 invoice loaded; more are available.',
    )

    document.querySelector<HTMLButtonElement>('[data-invoice-load-more]')!.click()
    await vi.waitFor(() =>
      expect(
        document.querySelector('tbody tr[data-row-key="8"]')?.textContent,
      ).toContain('Invoice INV-8'),
    )
    expect(listInvoices).toHaveBeenNthCalledWith(1, undefined, expect.anything(), undefined, [
      'draft',
      'open',
    ])
    expect(listInvoices).toHaveBeenNthCalledWith(2, 'next-page', expect.anything(), undefined, [
      'draft',
      'open',
    ])
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '2 invoices loaded.',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-load-more]')?.hidden).toBe(
      true,
    )
  })


  it('[acceptance] searches the loaded invoices by number and by client', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi.fn(async () => ({
      data: [invoice(7), invoice(8, { number: 'INV-2048', client_id: 12 })],
      page: { next_cursor: null },
    }))
    const listClients: ShellApi['listClients'] = async () => ({
      data: [resource(11, 'Northwind Freight'), resource(12, 'Acme Supply')],
      page: { next_cursor: null },
    })
    const api: ShellApi = { ...base, listInvoices, listClients }

    await mountShell(api)
    await vi.waitFor(() =>
      expect(
        document.querySelector('tbody tr[data-row-key="7"] td[data-column="client"]')
          ?.textContent,
      ).toBe('Northwind Freight'),
    )

    const rows = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('tbody tr[data-row-key]')].map(
        (row) => row.dataset.rowKey ?? '',
      )
    const search = document.querySelector<HTMLInputElement>('[data-invoice-search]')!
    expect(rows()).toEqual(['7', '8'])

    search.value = '2048'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows()).toEqual(['8'])
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '1 of 2 loaded invoices match.',
    )

    // The client name is the column a reader is looking at, so it is the one
    // the search reads too.
    search.value = 'northwind'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows()).toEqual(['7'])

    search.value = 'no such invoice'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows()).toEqual([])
    expect(document.querySelector('[data-invoice-list]')?.textContent).toContain(
      'No loaded invoices match that search.',
    )
  })
  it('[security] blocks a member before requesting invoice data', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi.fn()
    const api: ShellApi = {
      ...base,
      whoami: vi.fn(async () => secondIdentity),
      listInvoices,
    }

    await mountShell(api)

    expect(listInvoices).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      'Your profile does not have access to invoices.',
    )
  })

  it('[security] blocks an invoice list token without read scope before requesting data', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi.fn()
    const scopedIdentity: Whoami = {
      ...identity,
      authentication: { kind: 'token', token_id: 10, scopes: ['expenses:read'] },
    }
    const api: ShellApi = {
      ...base,
      whoami: vi.fn(async () => scopedIdentity),
      listInvoices,
    }

    await mountShell(api)

    expect(listInvoices).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      'This API token does not grant invoice read access.',
    )
  })

  it('[acceptance] renders persisted invoice lines, notes, payments, and history', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => invoice(7)),
      listInvoiceMessages: vi.fn(async () => [invoiceMessage(7)]),
      listInvoicePayments: vi.fn(async () => [
        {
          ...invoicePayment(7),
          provider: 'wise',
          provider_shape: 'reconciliation',
          provider_account_id: 3,
          provider_transaction_id: 'wise-transfer-42',
          bank_deposit_id: 4,
        },
      ]),
    }

    await mountShell(api)

    const documentShell = document.querySelector<HTMLElement>('[data-invoice-document]')!
    expect(documentShell.hidden).toBe(false)
    expect(document.title).toBe('ezacto — Invoice INV-7')
    expect(documentShell.textContent).toContain('August services')
    expect(documentShell.textContent).toContain('Implementation')
    expect(documentShell.textContent).toContain('$75.00')
    expect(documentShell.textContent).toContain('Thank you for your business.')
    expect(documentShell.textContent).toContain('$20.00')
    expect(documentShell.textContent).toContain('ACH deposit')
    expect(documentShell.textContent).toContain('Method: Wise')
    expect(documentShell.textContent).toContain('Reference: wise-transfer-42')
    expect(documentShell.textContent).toContain('Invoice available')
    expect(documentShell.textContent).toContain('Accounts payable')
    expect(documentShell.textContent).toContain('Persisted message body')
    expect(documentShell.textContent).not.toMatch(/Download PDF|Send reminder/u)
  })

  it('[e2e:invoice-cycle] sends a draft through the composer and shows its scheduled reminder', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    let attempts = 0
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        attempts += 1
        if (attempts === 1) throw new Error('network unavailable')
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: 2,
          sent_at: timestamp,
        }
        messages = [
          {
            ...invoiceMessage(7),
            event_type: 'send',
            recipients: input.recipients ?? [],
            subject: input.subject ?? null,
            body: input.body ?? null,
            attach_pdf: input.attach_pdf ?? false,
            send_me_a_copy: input.send_me_a_copy ?? false,
            reminder: input.reminder ?? false,
            send_reminder_on: input.send_reminder_on ?? null,
          },
        ]
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      transitionInvoice,
    }

    await mountShell(api)
    const send = document.querySelector<HTMLButtonElement>('[data-invoice-send]')!
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    expect(send.hidden).toBe(false)
    expect(send.textContent).toBe('Send invoice')
    // One Send control now, not a Send/Mark sent pair with contradictory hints.
    expect(document.querySelector('[data-invoice-deliver]')).toBeNull()
    expect(document.querySelector('[data-invoice-delivery-dialog]')).toBeNull()

    send.click()
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain('%invoice_number%')
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(dialog.open).toBe(false)
    expect(transitionInvoice).not.toHaveBeenCalled()
    send.click()
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close][aria-label]')!.click()
    expect(dialog.open).toBe(false)
    expect(transitionInvoice).not.toHaveBeenCalled()

    send.click()
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    const subject = document.querySelector<HTMLInputElement>('[data-invoice-composer-subject]')!
    const body = document.querySelector<HTMLTextAreaElement>('[data-invoice-composer-body]')!
    recipients.value = 'Accounts Payable <ap@example.test>\nap@example.test'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    subject.value = 'Invoice %invoice_number%'
    body.value = 'Invoice #%invoice_id% totals %invoice_amount% and is due %invoice_due_date%.'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'network unavailable',
      ),
    )
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))

    expect(transitionInvoice).toHaveBeenCalledTimes(2)
    expect(transitionInvoice.mock.calls[0]?.[1]).toBe(transitionInvoice.mock.calls[1]?.[1])
    expect(transitionInvoice.mock.calls[1]?.[2]).toEqual({
      command: 'send',
      expected_version: 1,
      recipients: [{ name: 'Accounts Payable', email: 'ap@example.test' }],
      subject: 'Invoice INV-7',
      body: 'Invoice #7 totals $82.50 and is due 2099-09-30.',
      attach_pdf: false,
      send_me_a_copy: false,
      thank_you: false,
      reminder: true,
      send_reminder_on: '2099-09-30',
    })
    // sent_at is stamped, so the document says Sent rather than Open: the
    // difference between an invoice still to send and one being waited on.
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Sent')
    expect(document.querySelector('[data-invoice-reminder-line]')?.textContent).toContain(
      'Sep 30, 2099',
    )
    expect(document.querySelector('[data-invoice-detail-messages]')?.textContent).toContain(
      'Invoice #7 totals $82.50',
    )
    expect(send.textContent).toBe('Send invoice again')
  })

  it('[e2e:invoice-email] sends and delivers from one dialog and retries the email alone', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          {
            ...invoiceMessage(7),
            event_type: 'send',
            recipients: input.recipients ?? [],
            subject: input.subject ?? null,
            body: input.body ?? null,
          },
        ]
        return currentInvoice
      },
    )
    let deliveries = 0
    const deliverInvoiceEmail = vi.fn(
      async (_id: number, _commandId: string, input: { expected_version: number }) => {
        deliveries += 1
        if (deliveries === 1) throw new Error('network unavailable')
        currentInvoice = { ...currentInvoice, version: input.expected_version + 1 }
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      deliverInvoiceEmail,
      transitionInvoice,
    }

    await mountShell(api)
    const send = document.querySelector<HTMLButtonElement>('[data-invoice-send]')!
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    send.click()
    expect(dialog.open).toBe(true)
    // The dialog says the two things are separate and which order they run in.
    expect(dialog.textContent).toContain('Also deliver by email')
    expect(dialog.textContent).toContain("It lists this invoice's line items; no PDF is attached")
    expect(dialog.textContent).toContain('%invoice_number%')

    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    const deliverToggle = document.querySelector<HTMLInputElement>(
      '[data-invoice-composer-deliver-toggle]',
    )!
    const confirmLabel = document.querySelector<HTMLElement>(
      '[data-invoice-composer-confirm-label]',
    )!
    // The confirmation only exists while the irreversible half is being asked for.
    expect(confirmLabel.hidden).toBe(true)
    deliverToggle.click()
    expect(confirmLabel.hidden).toBe(false)
    expect(document.querySelector('[data-invoice-composer-submit]')?.textContent).toBe(
      'Send and deliver',
    )

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
      'Confirm the recipients before sending this invoice email.',
    )
    expect(transitionInvoice).not.toHaveBeenCalled()
    expect(deliverInvoiceEmail).not.toHaveBeenCalled()

    document.querySelector<HTMLInputElement>('[data-invoice-composer-confirm]')!.click()
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toContain(
        'submit again to retry the email alone',
      ),
    )
    // The sent status committed before the email failed. Submitting again must
    // retry the email at the version the transition returned -- not record a
    // second sent message on an invoice that is already sent.
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(transitionInvoice.mock.calls[0]?.[2]).toMatchObject({
      command: 'send',
      expected_version: 1,
      recipients: [{ name: 'Accounts Payable', email: 'AP@Example.Test' }],
    })

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    // Both attempts carry the version the transition returned, not the one the
    // page was showing when the dialog opened.
    for (const call of deliverInvoiceEmail.mock.calls) {
      expect(call[2]).toEqual({
        expected_version: 2,
        recipients: [{ name: 'Accounts Payable', email: 'AP@Example.Test' }],
        confirmed: true,
      })
    }
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toContain(
      'Invoice marked sent and the email queued for the confirmed recipients.',
    )
  })

  /**
   * The three ways back into a send that has already committed. Each one used
   * to rearm the transition, and a second `send` is a second sent message in
   * the client's inbox -- POST /deliveries issues its own send on top.
   */
  const sendAndFailTheEmail = async (
    failure: unknown,
  ): Promise<{
    readonly dialog: HTMLDialogElement
    readonly form: HTMLFormElement
    readonly transitionInvoice: ReturnType<typeof vi.fn>
    readonly deliverInvoiceEmail: ReturnType<typeof vi.fn>
    readonly sentMessages: () => number
  }> => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          ...messages,
          {
            ...invoiceMessage(7),
            id: messages.length + 1,
            event_type: 'send',
            recipients: input.recipients ?? [],
          },
        ]
        return currentInvoice
      },
    )
    let deliveries = 0
    const deliverInvoiceEmail = vi.fn(
      async (_id: number, _commandId: string, input: { expected_version: number }) => {
        deliveries += 1
        if (deliveries === 1) throw failure
        // The delivery route runs its own `send` once the mail is accepted.
        currentInvoice = { ...currentInvoice, version: input.expected_version + 1 }
        messages = [
          ...messages,
          { ...invoiceMessage(7), id: messages.length + 1, event_type: 'send' },
        ]
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      deliverInvoiceEmail,
      transitionInvoice,
    }

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLInputElement>('[data-invoice-composer-deliver-toggle]')!.click()
    document.querySelector<HTMLInputElement>('[data-invoice-composer-confirm]')!.click()
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    // Settle on the controls coming back, not on any particular wording: what
    // each test is here to measure is the requests the next submit makes.
    await vi.waitFor(() => {
      expect(deliverInvoiceEmail).toHaveBeenCalledTimes(1)
      expect(
        document.querySelector<HTMLButtonElement>('[data-invoice-composer-submit]')?.disabled,
      ).toBe(false)
    })
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    return {
      dialog,
      form,
      transitionInvoice,
      deliverInvoiceEmail,
      sentMessages: () => messages.filter((message) => message.event_type === 'send').length,
    }
  }

  it('[reliability] retries the email alone after the delivery loses a version race', async () => {
    // The one error class most likely to land between two sequential versioned
    // writes: another operator, a payment, or the cron writing in between.
    const { dialog, form, transitionInvoice, deliverInvoiceEmail, sentMessages } =
      await sendAndFailTheEmail(
        new EzactoApiError(
          409,
          { error: { code: 'invoice_version_conflict', message: 'server conflict', fields: [] } },
          null,
        ),
      )
    // The conflict reloaded the invoice, so the composer is back under the
    // operator's hand with both boxes ticked -- and the sent status is on the
    // invoice already.
    expect(dialog.open).toBe(true)
    expect(sentMessages()).toBe(1)
    const reported = document.querySelector('[data-invoice-composer-result]')?.textContent

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    // One operator intent, one `send` transition. The retry is the email alone,
    // under the command id the first attempt used.
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(transitionInvoice.mock.calls[0]?.[2]).toMatchObject({ expected_version: 1 })
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    // The retry goes out at the version the reload found, not the stale one.
    expect(deliverInvoiceEmail.mock.calls[1]?.[2]).toEqual({
      expected_version: 2,
      recipients: [{ name: 'Accounts Payable', email: 'AP@Example.Test' }],
      confirmed: true,
    })
    // Two sent messages in the history is the whole budget: the operator's and
    // the one POST /deliveries issues. A third would be the reissued transition.
    expect(sentMessages()).toBe(2)
    // The conflict's own message said the invoice moved; the attempt added what
    // is left, which is the line the cleared flag used to swallow.
    expect(reported).toContain('Latest values are loaded')
    expect(reported).toContain('submit again to retry the email alone')
  })

  it('[reliability] reports an owed email taken off the submit instead of claiming a send', async () => {
    const { dialog, form, transitionInvoice, deliverInvoiceEmail, sentMessages } =
      await sendAndFailTheEmail(new Error('network unavailable'))
    const deliverToggle = document.querySelector<HTMLInputElement>(
      '[data-invoice-composer-deliver-toggle]',
    )!
    deliverToggle.click()
    const submitLabel = document.querySelector('[data-invoice-composer-submit]')?.textContent

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(1)
    expect(sentMessages()).toBe(1)
    const status = document.querySelector('[data-invoice-payment-status]')?.textContent
    expect(status).toBe('The sent status was already recorded. The email was not sent.')
    // No success sentence for zero API calls, and no repeat of the previous
    // attempt's reminder claim.
    expect(status).not.toContain('Planned reminder date saved')
    expect(status).not.toContain('marked sent and the email queued')
    // The button named the request this submit would make, and with the send
    // already recorded and the email taken off there was none.
    expect(submitLabel).toBe('Skip the email')
  })

  it('[reliability] resumes the owed email when the composer is closed and reopened', async () => {
    const { dialog, form, transitionInvoice, deliverInvoiceEmail, sentMessages } =
      await sendAndFailTheEmail(new Error('network unavailable'))
    // Cancel, the x and Escape are all offered and nothing warns against them.
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(dialog.open).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    expect(dialog.open).toBe(true)
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    const reopened = {
      title: document.querySelector('[data-invoice-composer-title]')?.textContent,
      notice: document.querySelector<HTMLElement>('[data-invoice-composer-owed]')?.hidden,
      submit: document.querySelector('[data-invoice-composer-submit]')?.textContent,
      recipients: recipients.value,
      frozen: recipients.disabled,
      delivering: document.querySelector<HTMLInputElement>(
        '[data-invoice-composer-deliver-toggle]',
      )?.checked,
    }
    // The operator fills the dialog in again the way a fresh send would need.
    // Nothing typed here may turn the owed email back into a second send.
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    expect(sentMessages()).toBe(2)
    // Reopening resumed the attempt rather than arming a fresh send, and said
    // so: the confirmed recipients restored past the form reset and frozen,
    // because they are what the retry delivers to under the first command id.
    expect(reopened).toEqual({
      title: 'Finish sending invoice',
      notice: false,
      submit: 'Retry the email',
      recipients: 'Accounts Payable <AP@Example.Test>',
      frozen: true,
      delivering: true,
    })
  })

  it('[reliability] never reissues a committed send when its detail refresh fails', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    let failNextRefresh = false
    const getInvoice = vi.fn(async () => {
      if (failNextRefresh) {
        failNextRefresh = false
        throw new Error('refresh offline')
      }
      return currentInvoice
    })
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = { ...currentInvoice, state: 'open', version: 2, sent_at: timestamp }
        messages = [
          {
            ...invoiceMessage(7),
            event_type: 'send',
            recipients: input.recipients ?? [],
            send_reminder_on: input.send_reminder_on ?? null,
          },
        ]
        failNextRefresh = true
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice,
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      transitionInvoice,
    }

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'ap@example.test'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    const retry = document.querySelector<HTMLButtonElement>('[data-invoice-detail-retry]')!
    await vi.waitFor(() => expect(retry.hidden).toBe(false))
    expect(dialog.open).toBe(false)
    expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
      'refresh offline',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-send]')?.disabled).toBe(true)
    expect(transitionInvoice).toHaveBeenCalledTimes(1)

    retry.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Sent'),
    )
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
  })

  it('[reliability] retires a send key the ledger says already committed', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    // A command ledger, because the whole question is what a spent key does.
    // A row is written only when the command commits, an identical retry is
    // replayed off it, and a changed one is refused as `command_id_reused` --
    // so that code is the server saying this key's command did commit.
    const ledger = new Map<string, string>()
    const transitionInvoice = vi.fn(
      async (_id: number, commandId: string, input: InvoiceTransitionInput) => {
        const fingerprint = JSON.stringify(input)
        const recorded = ledger.get(commandId)
        if (recorded !== undefined) {
          if (recorded !== fingerprint) {
            throw new EzactoApiError(
              409,
              {
                error: {
                  code: 'command_id_reused',
                  message: 'the idempotency key was already used for different input',
                  fields: [],
                },
              },
              null,
            )
          }
          return currentInvoice
        }
        ledger.set(commandId, fingerprint)
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          ...messages,
          {
            ...invoiceMessage(7),
            id: messages.length + 1,
            event_type: 'send',
            recipients: input.recipients ?? [],
          },
        ]
        // The first send commits and its response never arrives.
        if (ledger.size === 1) throw new Error('connection dropped')
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      transitionInvoice,
    }
    const sentMessages = (): number =>
      messages.filter((message) => message.event_type === 'send').length

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    const subject = document.querySelector<HTMLInputElement>('[data-invoice-composer-subject]')!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'connection dropped',
      ),
    )
    // Committed server-side, unknown to the page: it is still showing the draft.
    expect(sentMessages()).toBe(1)
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Draft')

    // The operator does the obvious thing and corrects the subject.
    subject.value = 'Invoice %invoice_number% (corrected)'
    subject.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Sent'),
    )
    const refused = document.querySelector('[data-invoice-composer-result]')?.textContent ?? ''
    // The spent key was refused, and the truth is that the invoice went out --
    // not that somebody else moved it, which is what the conflict line claims.
    expect(refused).toContain('already recorded as sent')
    expect(refused).not.toContain('changed elsewhere')
    expect(transitionInvoice).toHaveBeenCalledTimes(2)
    expect(sentMessages()).toBe(1)
    // The dialog is a working control again, not a repeat of the same refusal.
    expect(dialog.open).toBe(true)
    expect(document.querySelector('[data-invoice-composer-title]')?.textContent).toBe(
      'Send invoice again',
    )
    expect(recipients.disabled).toBe(false)

    // A deliberate second send is now reachable, under a key of its own.
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(3)
    expect(transitionInvoice.mock.calls[2]?.[1]).not.toBe(transitionInvoice.mock.calls[0]?.[1])
    expect(transitionInvoice.mock.calls[2]?.[2]).toMatchObject({
      command: 'send',
      expected_version: 2,
      subject: 'Invoice INV-7 (corrected)',
    })
    expect(sentMessages()).toBe(2)
  })

  it('[reliability] retires a delivery key the ledger says already committed', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          ...messages,
          {
            ...invoiceMessage(7),
            id: messages.length + 1,
            event_type: 'send',
            recipients: input.recipients ?? [],
          },
        ]
        return currentInvoice
      },
    )
    const deliveryLedger = new Map<string, string>()
    const deliverInvoiceEmail = vi.fn(
      async (_id: number, commandId: string, input: { expected_version: number }) => {
        const fingerprint = JSON.stringify(input)
        const recorded = deliveryLedger.get(commandId)
        if (recorded !== undefined) {
          if (recorded !== fingerprint) {
            throw new EzactoApiError(
              409,
              {
                error: {
                  code: 'command_id_reused',
                  message: 'the idempotency key was already used for different input',
                  fields: [],
                },
              },
              null,
            )
          }
          return currentInvoice
        }
        deliveryLedger.set(commandId, fingerprint)
        // The delivery route runs its own `send` once the mail is accepted, so
        // the invoice moves on -- and then the response is lost.
        currentInvoice = { ...currentInvoice, version: input.expected_version + 1 }
        messages = [
          ...messages,
          { ...invoiceMessage(7), id: messages.length + 1, event_type: 'send' },
        ]
        throw new Error('connection dropped')
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      deliverInvoiceEmail,
      transitionInvoice,
    }
    const sentMessages = (): number =>
      messages.filter((message) => message.event_type === 'send').length

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLInputElement>('[data-invoice-composer-deliver-toggle]')!.click()
    document.querySelector<HTMLInputElement>('[data-invoice-composer-confirm]')!.click()
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toContain(
        'submit again to retry the email alone',
      ),
    )
    // The email committed too; only its response went missing. The reload moved
    // the page to the version the delivery's own send left behind, so the retry
    // will not match the fingerprint the ledger holds.
    expect(sentMessages()).toBe(2)

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toContain(
        'already queued',
      ),
    )
    const refused = document.querySelector('[data-invoice-composer-result]')?.textContent ?? ''
    expect(refused).not.toContain('changed elsewhere')
    // Neither half runs again on the refusal, and the owed-email line is gone
    // with the key it belonged to.
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    expect(refused).not.toContain('retry the email alone')
    expect(sentMessages()).toBe(2)
    // The dialog is a send dialog again rather than a frozen retry of an email
    // that already went.
    expect(dialog.open).toBe(true)
    expect(document.querySelector('[data-invoice-composer-title]')?.textContent).toBe(
      'Send invoice again',
    )
    expect(document.querySelector('[data-invoice-composer-submit]')?.textContent).toBe(
      'Send and deliver',
    )
    expect(recipients.disabled).toBe(false)
  })

  it('[reliability] keeps the spent key on the page when the reload closes the dialog', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    let attempts = 0
    const transitionInvoice = vi.fn(async () => {
      attempts += 1
      if (attempts > 1) {
        throw new EzactoApiError(
          409,
          {
            error: {
              code: 'command_id_reused',
              message: 'the idempotency key was already used for different input',
              fields: [],
            },
          },
          null,
        )
      }
      // The send commits, and while its lost response is being retried the
      // invoice is paid in full -- a state that takes no send at all.
      currentInvoice = { ...currentInvoice, state: 'paid', version: 3, sent_at: timestamp }
      messages = [{ ...invoiceMessage(7), event_type: 'send' }]
      throw new Error('connection dropped')
    })
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      transitionInvoice,
    }

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'ap@example.test'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'connection dropped',
      ),
    )

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    // The dialog it was written into is gone; the sentence the operator has to
    // read -- their invoice went out -- may not go with it.
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toContain(
      'already recorded as sent',
    )
    expect(transitionInvoice).toHaveBeenCalledTimes(2)
  })

  it('[e2e:invoice-cycle] retries, records, edits, and deletes an exact manual payment', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, {
      state: 'open',
      version: 1,
      amount_cents: 6_250,
      due_amount_cents: 6_250,
    })
    let effectivePayments: InvoicePayment[] = []
    let recordAttempts = 0
    const recordInvoicePayment = vi.fn(
      async (_id: number, _commandId: string, input: InvoicePaymentInput) => {
        recordAttempts += 1
        if (recordAttempts === 1) throw new Error('network unavailable')
        currentInvoice = {
          ...currentInvoice,
          state: 'paid',
          version: 2,
          due_amount_cents: 0,
          paid_date: 'paid_date' in input ? input.paid_date : null,
          paid_at: 'paid_at' in input ? input.paid_at : null,
        }
        effectivePayments = [
          invoicePayment(7),
        ].map((payment) => ({
          ...payment,
          amount_cents: input.amount_cents,
          paid_at: 'paid_at' in input ? input.paid_at : null,
          paid_date: 'paid_date' in input ? input.paid_date : null,
          notes: input.notes ?? null,
        }))
        return currentInvoice
      },
    )
    const updateInvoicePayment = vi.fn(
      async (
        _id: number,
        _paymentId: number,
        _commandId: string,
        input: InvoicePaymentUpdateInput,
      ) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: 3,
          due_amount_cents: 1_000,
          paid_at: null,
          paid_date: null,
        }
        effectivePayments = effectivePayments.map((payment) => ({
          ...payment,
          amount_cents: input.amount_cents,
          paid_at: 'paid_at' in input ? input.paid_at : null,
          paid_date: 'paid_date' in input ? input.paid_date : null,
          notes: input.notes ?? null,
          updated_at: '2026-08-29T12:00:00.000Z',
        }))
        return currentInvoice
      },
    )
    const deleteInvoicePayment = vi.fn(
      async () => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: 4,
          due_amount_cents: 6_250,
          paid_at: null,
          paid_date: null,
        }
        effectivePayments = []
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => effectivePayments),
      recordInvoicePayment,
      updateInvoicePayment,
      deleteInvoicePayment,
    }

    await mountShell(api)
    const record = document.querySelector<HTMLButtonElement>(
      '[data-invoice-payment-record]',
    )!
    expect(record.disabled).toBe(false)
    record.click()
    const paymentDialog = document.querySelector<HTMLDialogElement>(
      '[data-invoice-payment-dialog]',
    )!
    const paymentForm = document.querySelector<HTMLFormElement>(
      '[data-invoice-payment-form]',
    )!
    const amount = document.querySelector<HTMLInputElement>(
      '[data-invoice-payment-amount]',
    )!
    const paymentNotes = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-payment-notes]',
    )!
    const paidDate = document.querySelector<HTMLInputElement>(
      '[data-invoice-payment-date]',
    )!
    expect(paymentDialog.open).toBe(true)
    expect(amount.value).toBe('62.50')
    expect(paymentDialog.textContent).toContain('No email or thank-you message will be sent.')
    paidDate.value = '2026-08-28'
    paymentNotes.value = 'Final ACH receipt'
    paymentNotes.dispatchEvent(new Event('input', { bubbles: true }))
    paymentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-payment-result]')?.textContent).toBe(
        'network unavailable',
      ),
    )
    expect(amount.disabled).toBe(false)
    paymentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(paymentDialog.open).toBe(false))
    expect(recordInvoicePayment).toHaveBeenCalledTimes(2)
    expect(recordInvoicePayment.mock.calls[0]?.[1]).toBe(
      recordInvoicePayment.mock.calls[1]?.[1],
    )
    expect(recordInvoicePayment.mock.calls[1]?.[2]).toEqual({
      expected_version: 1,
      amount_cents: 6_250,
      currency: 'USD',
      paid_date: '2026-08-28',
      notes: 'Final ACH receipt',
    })
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Paid')
    expect(document.querySelector('[data-invoice-detail-due]')?.textContent).toBe('$0.00')
    expect(document.querySelector('[data-invoice-detail-payments]')?.textContent).toContain(
      'Final ACH receipt',
    )

    document.querySelector<HTMLButtonElement>('[data-invoice-payment-edit="1"]')!.click()
    amount.value = '52.50'
    amount.dispatchEvent(new Event('input', { bubbles: true }))
    const precision = document.querySelector<HTMLSelectElement>(
      '[data-invoice-payment-precision]',
    )!
    const paidAt = document.querySelector<HTMLInputElement>(
      '[data-invoice-payment-instant]',
    )!
    precision.value = 'timestamp'
    precision.dispatchEvent(new Event('change', { bubbles: true }))
    paidAt.value = '2026-08-29T09:30'
    paymentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(paymentDialog.open).toBe(false))
    expect(updateInvoicePayment).toHaveBeenCalledWith(
      7,
      1,
      expect.stringMatching(/^web\.invoice\.payment\.update:/u),
      expect.objectContaining({
        expected_version: 2,
        expected_updated_at: timestamp,
        amount_cents: 5_250,
        paid_at: new Date(2026, 7, 29, 9, 30).toISOString(),
      }),
      expect.any(AbortSignal),
    )
    expect(vi.mocked(updateInvoicePayment).mock.lastCall?.[3]).not.toHaveProperty('paid_date')
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Open')
    expect(document.querySelector('[data-invoice-detail-due]')?.textContent).toBe('$10.00')

    const openDelete = (): void =>
      document.querySelector<HTMLButtonElement>('[data-invoice-payment-delete="1"]')!.click()
    openDelete()
    const deleteDialog = document.querySelector<HTMLDialogElement>(
      '[data-invoice-payment-delete-dialog]',
    )!
    deleteDialog.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(deleteDialog.open).toBe(false)
    expect(deleteInvoicePayment).not.toHaveBeenCalled()
    openDelete()
    deleteDialog
      .querySelector<HTMLButtonElement>('[data-dialog-close][aria-label]')!
      .click()
    expect(deleteDialog.open).toBe(false)
    expect(deleteInvoicePayment).not.toHaveBeenCalled()
    openDelete()
    deleteDialog
      .querySelector<HTMLFormElement>('[data-invoice-payment-delete-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(deleteDialog.open).toBe(false))
    expect(deleteInvoicePayment).toHaveBeenCalledWith(
      7,
      1,
      expect.stringMatching(/^web\.invoice\.payment\.delete:/u),
      { expected_version: 3, expected_updated_at: '2026-08-29T12:00:00.000Z' },
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Open')
    expect(document.querySelector('[data-invoice-detail-due]')?.textContent).toBe('$62.50')
    expect(document.querySelector('[data-invoice-detail-payments]')?.textContent).toContain(
      'No payments recorded.',
    )
  })

  it('[security] renders invoice payments read-only for a read-scoped token', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    const readIdentity: Whoami = {
      ...identity,
      authentication: { kind: 'token', token_id: 9, scopes: ['invoices:read'] },
    }
    const recordInvoicePayment = vi.fn()
    const api: ShellApi = {
      ...base,
      whoami: vi.fn(async () => readIdentity),
      getInvoice: vi.fn(async () => invoice(7, { state: 'open' })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => [invoicePayment(7)]),
      recordInvoicePayment,
    }

    await mountShell(api)

    expect(document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector('[data-invoice-payment-readonly]')?.textContent).toContain(
      'read-only',
    )
    expect(document.querySelector('[data-invoice-payment-edit]')).toBeNull()
    expect(document.querySelector('[data-invoice-payment-delete]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-send]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-line-add]')?.hidden).toBe(true)
    expect(document.querySelector('[data-invoice-line-edit]')).toBeNull()
    expect(document.querySelector('[data-invoice-line-delete]')).toBeNull()
    expect(document.querySelector('[data-invoice-line-readonly]')?.textContent).toContain(
      'read-only',
    )
    expect(recordInvoicePayment).not.toHaveBeenCalled()
  })

  it('[security] returns to sign-in when invoice browsing loses its session', async () => {
    renderBrowserShell({ view: 'invoice-list', sessionCookiePresent: true })
    const base = browserApi()
    const api: ShellApi = {
      ...base,
      listInvoices: vi.fn(async () => {
        throw authenticationError(401, 'authentication_required')
      }),
    }

    await mountShell(api)

    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
    expect(document.title).toBe('ezacto — Sign in')
  })
})
