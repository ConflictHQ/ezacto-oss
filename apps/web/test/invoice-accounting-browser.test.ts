/** @vitest-environment happy-dom */

import { EzactoApiError, type InvoicePaymentInput, type InvoiceQuickBooksEnvelope } from '@conflict-hq/ezacto-client'

import { describe, expect, it, vi } from 'vitest'
import { createInvoicePaymentController } from '../src/invoices/browser.js'

import { invoiceQuickBooksLine, invoiceRemindersLine, type InvoiceReminderPreference } from '../src/invoices/model.js'





import { identity, invoice, payment, renderDetail } from './invoice-browser-fixtures.js'


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

  it.each(['accounting', 'quickbooks'])('[browser #1217] makes no QuickBooks request where %s is unavailable', async (unavailable) => {
    renderDetail()
    document.documentElement.setAttribute(`data-${unavailable}-unavailable`, '')
    try {
      const getInvoiceQuickBooks = vi.fn(async () => refusedBeforeConnect)
      const controller = createInvoicePaymentController({
        getInvoice: vi.fn(async () => invoice('OFF')),
        listInvoiceMessages: vi.fn(async () => []),
        listInvoicePayments: vi.fn(async () => []),
        getInvoiceQuickBooks,
        syncInvoiceQuickBooks: vi.fn(),
      })
      await controller.activate(identity(1), new AbortController().signal, () => false)
      await vi.waitFor(() =>
        expect(document.querySelector('[data-invoice-document]')!.hasAttribute('hidden')).toBe(false),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(getInvoiceQuickBooks).not.toHaveBeenCalled()
      expect(fact().hidden).toBe(true)
      expect(button().hidden).toBe(true)
    } finally {
      document.documentElement.removeAttribute(`data-${unavailable}-unavailable`)
    }
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

