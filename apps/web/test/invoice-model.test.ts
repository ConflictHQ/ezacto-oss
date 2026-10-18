import type {
  Invoice,
  InvoiceDocumentPreferenceEnvelope,
  InvoiceLine,
  InvoiceMessage,
  InvoicePayment,
  Whoami,
} from '@conflict-hq/ezacto-client'
import { describe, expect, it } from 'vitest'
import {
  interpolateInvoiceTemplate,
  invoiceBandCeilingSeconds,
  invoiceBandPreview,
  invoiceBandTerms,
  invoiceCanIssueTransition,
  invoiceCanMarkSent,
  invoiceCanEditLines,
  invoiceCanRecordPayment,
  invoiceAttachmentChanges,
  invoiceAttachmentsEffective,
  invoiceDraft,
  invoiceDraftRebase,
  invoiceEditFocusFromHash,
  invoiceEditHref,
  invoiceEditPlan,
  invoiceIdentityCanRead,
  invoiceIdentityCanWrite,
  invoiceMessageLabel,
  invoiceOverflowTransitions,
  invoiceLineQuantityForForm,
  invoiceLineUnitPriceCents,
  invoiceLineUnitPriceForForm,
  invoiceLineValues,
  invoicePaymentAmountCents,
  invoicePaymentAmountForForm,
  invoicePaymentCanDelete,
  invoicePaymentCanUpdate,
  invoicePaymentDate,
  invoicePaymentInstant,
  invoicePaymentLocalInstant,
  invoicePaymentProviderLabel,
  invoicePaymentTiming,
  invoiceNumberIsAddressable,
  invoicePagePath,
  invoicePeriod,
  invoiceProfileHasAccess,
  invoiceRecipients,
  invoiceRecipientLine,
  invoiceReferenceFromPathname,
  invoiceReferencePath,
  invoiceReminderDate,
  invoicePlannedReminder,
  invoiceSendFailure,
  invoiceSendWork,
  invoiceStateLabel,
  invoiceStatusPill,
  type InvoiceSendAttempt,
} from '../src/invoices/model.js'

const invoice = (overrides: Partial<Invoice> = {}): Invoice =>
  ({
    state: 'draft',
    close_reason: null,
    sent_at: null,
    period_start: null,
    period_end: null,
    discount_amount_cents: 0,
    tax_amount_cents: 0,
    tax2_amount_cents: 0,
    line_items: [],
    ...overrides,
  }) as Invoice

const identity = (
  authentication: Whoami['authentication'],
  profile: Whoami['profile'] = 'accounting',
): Whoami => ({ user_id: 1, profile, manager_grants: [], authentication })

const payment = (overrides: Partial<InvoicePayment> = {}): InvoicePayment =>
  ({
    id: 1,
    invoice_id: 1,
    provider: 'manual',
    provider_shape: 'manual',
    recorded_by_user_id: 1,
    ...overrides,
  }) as InvoicePayment

describe('invoice workspace model', () => {
  it('[security] restricts invoices to finance-capable profiles', () => {
    expect(invoiceProfileHasAccess('member')).toBe(false)
    expect(invoiceProfileHasAccess('project_manager')).toBe(false)
    expect(invoiceProfileHasAccess('people_admin')).toBe(false)
    expect(invoiceProfileHasAccess('accounting')).toBe(true)
    expect(invoiceProfileHasAccess('executive_manager')).toBe(true)
    expect(invoiceProfileHasAccess('administrator')).toBe(true)
    expect(invoiceIdentityCanRead(identity({ kind: 'session' }))).toBe(true)
    expect(invoiceIdentityCanWrite(identity({ kind: 'session' }))).toBe(true)
    expect(
      invoiceIdentityCanRead(
        identity({ kind: 'token', token_id: 1, scopes: ['invoices:read'] }),
      ),
    ).toBe(true)
    expect(
      invoiceIdentityCanWrite(
        identity({ kind: 'token', token_id: 1, scopes: ['invoices:read'] }),
      ),
    ).toBe(false)
    expect(
      invoiceIdentityCanRead(
        identity({ kind: 'token', token_id: 1, scopes: ['invoices:write'] }),
      ),
    ).toBe(false)
    expect(
      invoiceIdentityCanRead(
        identity({ kind: 'token', token_id: 1, scopes: ['invoices:read'] }, 'member'),
      ),
    ).toBe(false)
  })

  it('[unit] reads an invoice page address as a number or a record id, and nothing else', () => {
    expect(invoiceReferenceFromPathname('/invoices/4021')).toEqual({ kind: 'number', number: '4021' })
    // Text, not a quantity: the leading zero is part of the number.
    expect(invoiceReferenceFromPathname('/invoices/089')).toEqual({ kind: 'number', number: '089' })
    expect(invoiceReferenceFromPathname('/invoices/INV-2026.07_b')).toEqual({
      kind: 'number',
      number: 'INV-2026.07_b',
    })
    expect(invoiceReferenceFromPathname('/invoices/4021/')).toEqual({ kind: 'number', number: '4021' })
    expect(invoiceReferenceFromPathname(`/invoices/${'9'.repeat(64)}`)).toEqual({
      kind: 'number',
      number: '9'.repeat(64),
    })
    expect(invoiceReferenceFromPathname('/invoices/by-id/42')).toEqual({ kind: 'id', id: 42 })
    expect(invoiceReferenceFromPathname('/invoices/by-id/42/')).toEqual({ kind: 'id', id: 42 })
    // The routes beside the invoices are never a number.
    for (const reserved of ['new', 'recurring', 'retainers', 'estimates', 'configure', 'by-id']) {
      expect(invoiceReferenceFromPathname(`/invoices/${reserved}`), reserved).toBeNull()
      expect(invoiceReferenceFromPathname(`/invoices/${reserved}/edit`, 'edit'), reserved).toBeNull()
    }
    // An id is a positive safe integer written plainly, or it is nothing.
    for (const id of ['0', '042', '-1', '9007199254740992', 'INV-7']) {
      expect(invoiceReferenceFromPathname(`/invoices/by-id/${id}`), id).toBeNull()
      expect(invoiceReferenceFromPathname(`/invoices/by-id/${id}/edit`, 'edit'), id).toBeNull()
    }
    // A segment a browser would rewrite, or one too long, is not an address.
    for (const segment of ['-12', '.12', '..', 'INV%2012', 'INV%2F12', 'Ä12', '9'.repeat(65)]) {
      expect(invoiceReferenceFromPathname(`/invoices/${segment}`), segment).toBeNull()
    }
    expect(invoiceReferenceFromPathname('/invoices')).toBeNull()
    expect(invoiceReferenceFromPathname('/invoices/12/edit')).toBeNull()
    expect(invoiceReferenceFromPathname('/invoices/by-id/12/edit')).toBeNull()
    // The edit page reads its own address the same way.
    expect(invoiceReferenceFromPathname('/invoices/089/edit', 'edit')).toEqual({
      kind: 'number',
      number: '089',
    })
    expect(invoiceReferenceFromPathname('/invoices/089/edit/', 'edit')).toEqual({
      kind: 'number',
      number: '089',
    })
    expect(invoiceReferenceFromPathname('/invoices/by-id/42/edit', 'edit')).toEqual({
      kind: 'id',
      id: 42,
    })
    // "edit" is a number like any other; its edit page is /invoices/edit/edit.
    expect(invoiceReferenceFromPathname('/invoices/edit', 'edit')).toBeNull()
    expect(invoiceReferenceFromPathname('/invoices/edit/edit', 'edit')).toEqual({
      kind: 'number',
      number: 'edit',
    })
    expect(invoiceReferenceFromPathname('/invoices/089', 'edit')).toBeNull()
  })

  it('[unit] addresses an invoice by its number, and by its id only where the number cannot be a path', () => {
    expect(invoicePagePath({ id: 42, number: '4021' })).toBe('/invoices/4021')
    expect(invoicePagePath({ id: 42, number: '4021' }, 'edit')).toBe('/invoices/4021/edit')
    expect(invoicePagePath({ id: 42, number: '089' })).toBe('/invoices/089')
    expect(invoicePagePath({ id: 42, number: 'INV-2026.07_b' })).toBe('/invoices/INV-2026.07_b')
    // No number to hand: the record id.
    expect(invoicePagePath({ id: 42, number: null })).toBe('/invoices/by-id/42')
    expect(invoicePagePath({ id: 42, number: undefined }, 'edit')).toBe('/invoices/by-id/42/edit')
    // A number spelled like a route beside it, or one that is not a path
    // segment, would open some other page; it goes by id instead.
    for (const number of [
      'new',
      'recurring',
      'retainers',
      'estimates',
      'configure',
      'by-id',
      '',
      'INV 7',
      'INV/7',
      'INV#7',
      'INV?7',
      'INV%7',
      '-7',
      '.7',
      '..',
      'Ä7',
      '7\n',
      '9'.repeat(65),
    ]) {
      expect(invoiceNumberIsAddressable(number), number).toBe(false)
      expect(invoicePagePath({ id: 42, number }), number).toBe('/invoices/by-id/42')
      expect(invoicePagePath({ id: 42, number }, 'edit'), number).toBe('/invoices/by-id/42/edit')
    }
    expect(invoiceNumberIsAddressable('New')).toBe(true)
    // Each address reads back as the page it was built for.
    for (const invoice of [
      { id: 42, number: '4021' },
      { id: 42, number: '089' },
      { id: 42, number: 'new' },
      { id: 9_007_199_254_740_991, number: null },
    ]) {
      for (const page of ['detail', 'edit'] as const) {
        const path = invoicePagePath(invoice, page)
        const reference = invoiceReferenceFromPathname(path, page)
        expect(reference, path).toEqual(
          invoice.number !== null && invoiceNumberIsAddressable(invoice.number)
            ? { kind: 'number', number: invoice.number }
            : { kind: 'id', id: invoice.id },
        )
        expect(invoiceReferencePath(reference!, page)).toBe(path)
      }
    }
    // The edit page opens on a line, or on a fresh one, by its hash.
    expect(invoiceEditHref({ id: 42, number: '089' })).toBe('/invoices/089/edit')
    expect(invoiceEditHref({ id: 42, number: '089' }, { line: 7 })).toBe('/invoices/089/edit#line-7')
    expect(invoiceEditHref({ id: 42, number: null }, 'new-line')).toBe(
      '/invoices/by-id/42/edit#new-line',
    )
    expect(invoiceEditFocusFromHash('#line-7')).toEqual({ line: 7 })
    expect(invoiceEditFocusFromHash('#new-line')).toBe('new-line')
    expect(invoiceEditFocusFromHash('#line-0')).toBeNull()
    expect(invoiceEditFocusFromHash('')).toBeNull()
  })

  it('[unit] colours the status pill draft, sent, late and paid', () => {
    const today = '2026-10-05'
    const sent = '2026-09-01T10:00:00.000Z'
    const owing = { due_amount_cents: 500, due_date: '2026-10-05' }
    expect(invoiceStatusPill(invoice(), today)).toEqual({ label: 'Draft', tone: 'draft' })
    expect(invoiceStatusPill(invoice({ state: 'open', sent_at: sent, ...owing }), today))
      .toEqual({ label: 'Sent', tone: 'sent' })
    // Due today is not late; the day after is, sent or not.
    expect(
      invoiceStatusPill(invoice({ state: 'open', sent_at: sent, ...owing }), '2026-10-06'),
    ).toEqual({ label: 'Late', tone: 'late' })
    expect(invoiceStatusPill(invoice({ state: 'open', ...owing }), '2026-10-06'))
      .toEqual({ label: 'Late', tone: 'late' })
    // Nothing left to collect is not late.
    expect(
      invoiceStatusPill(
        invoice({ state: 'open', due_amount_cents: 0, due_date: '2026-09-01' }),
        today,
      ),
    ).toEqual({ label: 'Open', tone: 'neutral' })
    expect(
      invoiceStatusPill(
        invoice({ state: 'paid', due_amount_cents: 0, due_date: '2026-09-01' }),
        today,
      ),
    ).toEqual({ label: 'Paid', tone: 'paid' })
    expect(invoiceStatusPill(invoice({ state: 'closed', close_reason: 'cancelled' }), today))
      .toEqual({ label: 'Cancelled', tone: 'neutral' })
  })

  it('[unit] describes invoice state and period without inventing data', () => {
    expect(invoiceStateLabel(invoice())).toBe('Draft')
    expect(invoiceStateLabel(invoice({ state: 'closed' }))).toBe('Closed')
    expect(
      invoiceStateLabel(invoice({ state: 'closed', close_reason: 'written_off' })),
    ).toBe('Written off')
    // Open means it exists and is billable; Sent means it reached the client.
    // Both read as Open before, which is the difference between an invoice you
    // still have to send and one you are waiting on.
    expect(invoiceStateLabel(invoice({ state: 'open' }))).toBe('Open')
    expect(
      invoiceStateLabel(
        invoice({ state: 'open', sent_at: '2026-09-01T10:00:00.000Z' }),
      ),
    ).toBe('Sent')
    // Sending is not a step in the sequence -- an invoice can be paid without
    // ever having been sent, and a paid one says Paid whatever its sent_at.
    expect(
      invoiceStateLabel(
        invoice({ state: 'paid', sent_at: '2026-09-01T10:00:00.000Z' }),
      ),
    ).toBe('Paid')
    expect(
      invoiceStateLabel(
        invoice({ state: 'closed', sent_at: '2026-09-01T10:00:00.000Z' }),
      ),
    ).toBe('Closed')
    expect(invoicePeriod(invoice())).toBeNull()
    expect(
      invoicePeriod(
        invoice({ period_start: '2026-08-01', period_end: '2026-08-31' }),
      ),
    ).toBe('2026-08-01 – 2026-08-31')
  })

  it('[unit] uses only persisted message and payment facts', () => {
    expect(
      invoiceMessageLabel({ event_type: 'write_off' } as InvoiceMessage),
    ).toBe('write off')
    expect(invoiceMessageLabel({ event_type: null } as InvoiceMessage)).toBe(
      'Invoice activity',
    )
    expect(
      invoicePaymentDate({
        paid_date: '2026-08-21',
        paid_at: '2026-08-20T12:00:00.000Z',
      } as InvoicePayment),
    ).toBe('2026-08-21')
    expect(
      invoicePaymentDate({
        paid_date: null,
        paid_at: '2026-08-20T12:00:00.000Z',
      } as InvoicePayment),
    ).toBe('2026-08-20T12:00:00.000Z')
    expect(invoicePaymentProviderLabel(payment())).toBe('Manual')
    expect(invoicePaymentProviderLabel(payment({ provider: 'quickbooks' }))).toBe(
      'Quickbooks',
    )
  })

  it('[unit] parses positive decimal money into exact cents', () => {
    expect(invoicePaymentAmountCents('0.01')).toBe(1)
    expect(invoicePaymentAmountCents('19.9')).toBe(1_990)
    expect(invoicePaymentAmountCents('90000000000.00')).toBe(9_000_000_000_000)
    expect(invoicePaymentAmountForForm(1)).toBe('0.01')
    expect(invoicePaymentAmountForForm(1_990)).toBe('19.90')
    for (const invalid of ['0', '0.00', '-1', '1.001', '01.00', '1e2', '', '90000000000.01']) {
      expect(() => invoicePaymentAmountCents(invalid), invalid).toThrow()
    }
  })

  it('[unit] converts line quantity and signed rate into exact half-away cents', () => {
    expect(invoiceLineValues('0.1', '1.05')).toEqual({
      quantity: 0.1,
      unitPriceCents: 105,
      amountCents: 11,
    })
    expect(invoiceLineValues('-1.5', '1.01')).toEqual({
      quantity: -1.5,
      unitPriceCents: 101,
      amountCents: -152,
    })
    expect(invoiceLineValues('1.5', '-1.01').amountCents).toBe(-152)
    expect(invoiceLineUnitPriceCents('-90000000000.00')).toBe(-9_000_000_000_000)
    expect(invoiceLineUnitPriceForForm(-1)).toBe('-0.01')
    expect(
      invoiceLineQuantityForForm({ quantity: 0.125 } as Invoice['line_items'][number]),
    ).toBe('0.125')
  })

  it('[unit] rejects line decimals that JSON would silently change', () => {
    for (const invalid of ['', '01', '.5', '1e2', '9007199254740991.1']) {
      expect(() => invoiceLineValues(invalid, '1.00'), invalid).toThrow()
    }
    for (const invalid of ['', '01.00', '1.001', '1e2', '90000000000.01']) {
      expect(() => invoiceLineUnitPriceCents(invalid), invalid).toThrow()
    }
    expect(() => invoiceLineValues('2', '90000000000.00')).toThrow('too large')
  })

  it('[unit] represents exactly one canonical paid date or local instant', () => {
    expect(invoicePaymentTiming('date', '2026-08-31')).toEqual({
      paid_date: '2026-08-31',
    })
    expect(() => invoicePaymentTiming('date', '2026-02-30')).toThrow(
      'valid payment date',
    )
    const instant = invoicePaymentInstant('2026-08-31T09:45')
    const parsed = new Date(instant)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(7)
    expect(parsed.getDate()).toBe(31)
    expect(parsed.getHours()).toBe(9)
    expect(parsed.getMinutes()).toBe(45)
    expect(invoicePaymentTiming('timestamp', '2026-08-31T09:45')).toEqual({
      paid_at: instant,
    })
    expect(invoicePaymentLocalInstant(instant)).toBe('2026-08-31T09:45')
    expect(() => invoicePaymentInstant('2026-02-30T09:45')).toThrow(
      'valid payment date and time',
    )
  })

  it('[security] exposes payment mutations only for active native rows', () => {
    const open = invoice({ state: 'open', due_amount_cents: 100 })
    const paid = invoice({ state: 'paid', due_amount_cents: 0 })
    expect(invoiceCanRecordPayment(open)).toBe(true)
    expect(invoiceCanRecordPayment(paid)).toBe(false)
    expect(invoiceCanRecordPayment(invoice({ state: 'draft', due_amount_cents: 100 }))).toBe(
      false,
    )
    expect(invoicePaymentCanUpdate(open, payment())).toBe(true)
    expect(invoicePaymentCanDelete(paid, payment())).toBe(true)
    expect(
      invoicePaymentCanUpdate(open, payment({ provider: 'wise', provider_shape: 'reconciliation' })),
    ).toBe(false)
    expect(invoicePaymentCanDelete(open, payment({ recorded_by_user_id: null }))).toBe(false)
    expect(invoicePaymentCanDelete(invoice({ state: 'closed' }), payment())).toBe(false)
  })

  it('[unit] parses and deduplicates bounded invoice recipients', () => {
    expect(
      invoiceRecipients('billing@example.test\nAlex Kim <alex@example.test>\nBILLING@example.test'),
    ).toEqual([
      { name: '', email: 'billing@example.test' },
      { name: 'Alex Kim', email: 'alex@example.test' },
    ])
    expect(() => invoiceRecipients('')).toThrow('at least one recipient')
    expect(() => invoiceRecipients('not-an-email')).toThrow('valid recipient')
    expect(() => invoiceRecipients('Alex <broken@example>')).toThrow('valid recipient')
  })

  it('[unit] resolves only supported invoice template variables before sending', () => {
    const selected = invoice({
      id: 42,
      number: 'INV-0042',
      currency: 'USD',
      amount_cents: 12_345,
      due_date: '2026-09-30',
    })
    expect(
      interpolateInvoiceTemplate(
        '%invoice_number% (#%invoice_id%) is %invoice_amount%, due %invoice_due_date%. %unknown%',
        selected,
      ),
    ).toBe('INV-0042 (#42) is $123.45, due 2026-09-30. %unknown%')
  })

  it('[unit] records the billing period and the weekday in the organization zone (issue 925)', () => {
    const names = { clientName: '', companyName: '', timeZone: 'America/Costa_Rica' }
    const sentAt = '2026-10-10T02:00:00.000Z'
    expect(
      interpolateInvoiceTemplate(
        'Happy %send_weekday%: %invoice_period%',
        invoice({ period_start: '2026-08-15', period_end: '2026-09-14' }),
        names,
        sentAt,
      ),
    ).toBe('Happy Friday: August – September 2026')
    // No period reads as nothing; without the zone the weekday is left as typed
    // rather than guessed from this browser's own.
    expect(interpolateInvoiceTemplate('[%invoice_period%]', invoice(), names, sentAt)).toBe('[]')
    expect(interpolateInvoiceTemplate('%send_weekday%', invoice(), undefined, sentAt)).toBe(
      '%send_weekday%',
    )
  })

  it('[unit] resolves the lines a message is about, flattened onto their own rows', () => {
    const selected = invoice({
      currency: 'USD',
      amount_cents: 41_500,
      line_items: [
        {
          kind: 'Service',
          description: 'Discovery\nworkshop',
          quantity: 3,
          unit_price_cents: 12_500,
          amount_cents: 37_500,
        },
        {
          kind: 'Expense',
          description: null,
          quantity: 1,
          unit_price_cents: 4_000,
          amount_cents: 4_000,
        },
      ] as Invoice['line_items'],
    })
    expect(interpolateInvoiceTemplate('Owed:\n%invoice_line_items%', selected)).toBe(
      [
        'Owed:',
        'Line items',
        // A description is free text; a newline in it would otherwise look like
        // a line the invoice does not have.
        'Service: Discovery workshop',
        '  3 x $125.00 = $375.00',
        'Expense',
        '  1 x $40.00 = $40.00',
        'Total: $415.00',
      ].join('\n'),
    )
    expect(
      interpolateInvoiceTemplate('%invoice_line_items%', invoice({ currency: 'USD', amount_cents: 0, line_items: [] })),
    ).toBe(['Line items', 'This invoice has no line items.', 'Total: $0.00'].join('\n'))
  })

  // Line amounts are pre-tax; `amount_cents` is not. Recording a message whose
  // list contradicts the total it prints is the same defect on the composer
  // side, so the same rows reconcile it here.
  it('[unit] reconciles the recorded list to the taxed, discounted total', () => {
    const selected = invoice({
      currency: 'USD',
      amount_cents: 42_413,
      discount_amount_cents: 4_150,
      // Both taxes reach the client as the one Tax row the invoice document on
      // screen shows; dropping either would leave the column short.
      tax_amount_cents: 3_375,
      tax2_amount_cents: 1_688,
      line_items: [
        {
          kind: 'Service',
          description: 'Discovery workshop',
          quantity: 3,
          unit_price_cents: 12_500,
          amount_cents: 37_500,
        },
        {
          kind: 'Expense',
          description: null,
          quantity: 1,
          unit_price_cents: 4_000,
          amount_cents: 4_000,
        },
      ] as Invoice['line_items'],
    })
    expect(interpolateInvoiceTemplate('%invoice_line_items%', selected)).toBe(
      [
        'Line items',
        'Service: Discovery workshop',
        '  3 x $125.00 = $375.00',
        'Expense',
        '  1 x $40.00 = $40.00',
        'Subtotal: $415.00',
        'Discount: -$41.50',
        'Tax: $50.63',
        'Total: $424.13',
      ].join('\n'),
    )
  })

  it('[unit] validates reminder dates and derives the persisted open-invoice schedule', () => {
    expect(() => invoiceReminderDate('', '2026-09-02')).toThrow('reminder date')
    expect(invoiceReminderDate('2026-09-02', '2026-09-02')).toBe('2026-09-02')
    expect(() => invoiceReminderDate('2026-09-01', '2026-09-02')).toThrow('past')
    expect(() => invoiceReminderDate('2026-02-30', '2026-09-02')).toThrow('valid')
    const messages = [
      { event_type: 'send', send_reminder_on: '2026-09-10' },
      { event_type: 'send', send_reminder_on: '2026-09-12' },
    ] as InvoiceMessage[]
    expect(invoicePlannedReminder(invoice({ state: 'open' }), messages)).toBe('2026-09-12')
    expect(invoicePlannedReminder(invoice({ state: 'paid' }), messages)).toBeNull()
    expect(invoiceCanMarkSent(invoice({ state: 'draft' }))).toBe(true)
    expect(invoiceCanMarkSent(invoice({ state: 'open' }))).toBe(true)
    expect(invoiceCanMarkSent(invoice({ state: 'paid' }))).toBe(false)
    expect(invoiceCanEditLines(invoice({ state: 'draft' }))).toBe(true)
    expect(invoiceCanEditLines(invoice({ state: 'open' }))).toBe(true)
    expect(invoiceCanEditLines(invoice({ state: 'paid' }))).toBe(true)
    expect(invoiceCanEditLines(invoice({ state: 'closed' }))).toBe(false)
  })

  it('[unit] offers only the lifecycle verbs the reducer would accept', () => {
    // Every combination the menu can be asked about, against the rules in
    // @ezacto/core: a verb offered here that the reducer rejects is a round
    // trip to an illegal_invoice_transition the operator cannot act on.
    const draft = invoice({ state: 'draft', due_amount_cents: 1_000, written_off_cents: 0 })
    const open = invoice({ state: 'open', due_amount_cents: 1_000, written_off_cents: 0 })
    const settled = invoice({ state: 'open', due_amount_cents: 0, written_off_cents: 0 })
    const closed = invoice({ state: 'closed', due_amount_cents: 0, written_off_cents: 1_000 })
    const paid = invoice({ state: 'paid', due_amount_cents: 0, written_off_cents: 0 })

    // draft is only reachable from open, and only while nothing is recorded
    // against the invoice -- a payment or a write-off makes it illegal.
    expect(invoiceCanIssueTransition(open, 0, 'draft')).toBe(true)
    expect(invoiceCanIssueTransition(open, 1, 'draft')).toBe(false)
    expect(
      invoiceCanIssueTransition(invoice({ state: 'open', written_off_cents: 5 }), 0, 'draft'),
    ).toBe(false)
    expect(invoiceCanIssueTransition(draft, 0, 'draft')).toBe(false)
    expect(invoiceCanIssueTransition(closed, 0, 'draft')).toBe(false)

    expect(invoiceCanIssueTransition(draft, 0, 'cancel')).toBe(true)
    expect(invoiceCanIssueTransition(open, 3, 'cancel')).toBe(true)
    expect(invoiceCanIssueTransition(paid, 0, 'cancel')).toBe(false)
    expect(invoiceCanIssueTransition(closed, 0, 'cancel')).toBe(false)

    // write_off needs something left to write off.
    expect(invoiceCanIssueTransition(open, 0, 'write_off')).toBe(true)
    expect(invoiceCanIssueTransition(settled, 0, 'write_off')).toBe(false)
    expect(invoiceCanIssueTransition(draft, 0, 'write_off')).toBe(false)

    expect(invoiceCanIssueTransition(closed, 0, 'reopen')).toBe(true)
    expect(invoiceCanIssueTransition(open, 0, 'reopen')).toBe(false)
    expect(invoiceCanIssueTransition(paid, 0, 'reopen')).toBe(false)

    // The two verbs that close an invoice are the two marked destructive, and
    // destructive means red text -- never a red fill.
    expect(
      invoiceOverflowTransitions
        .filter((transition) => transition.destructive)
        .map((transition) => transition.command),
    ).toEqual(['write_off', 'cancel'])
    expect(invoiceOverflowTransitions.map((transition) => transition.command)).toEqual([
      'draft',
      'reopen',
      'write_off',
      'cancel',
    ])
    // Written off and Cancelled are the two labels invoiceStateLabel could
    // already render; these are the verbs that finally produce them.
    expect(invoiceStateLabel(invoice({ state: 'closed', close_reason: 'written_off' }))).toBe(
      'Written off',
    )
    expect(invoiceStateLabel(invoice({ state: 'closed', close_reason: 'cancelled' }))).toBe(
      'Cancelled',
    )
  })

  it('never offers a second send once an attempt has committed one', () => {
    const delivery = {
      commandId: 'web.invoice.delivery:1',
      recipients: [{ name: 'Accounts Payable', email: 'ap@example.test' }],
      cc: [],
      subject: 'Invoice #%invoice_number% from %company_name%',
      message: 'Hello,',
      sendMeACopy: false,
    }
    const attempting: InvoiceSendAttempt = {
      invoiceId: 7,
      transitionCommandId: 'web.invoice.send:1',
      sentVersion: null,
      delivery,
    }
    const sent: InvoiceSendAttempt = { ...attempting, sentVersion: 2 }

    // Nothing attempted yet, and an attempt whose `send` never committed: the
    // transition is what a submit owes, under the id it already minted.
    expect(invoiceSendWork(null, 7, true)).toBe('send')
    expect(invoiceSendWork(null, 7, false)).toBe('send')
    expect(invoiceSendWork(attempting, 7, true)).toBe('send')
    expect(invoiceSendWork(attempting, 7, false)).toBe('send')

    // Committed: the email alone, or nothing at all. Neither is a send, and the
    // checkbox cannot make it one.
    expect(invoiceSendWork(sent, 7, true)).toBe('delivery')
    expect(invoiceSendWork(sent, 7, false)).toBe('nothing')
    // A committed send with no email left owes nothing either -- least of all
    // another send.
    expect(invoiceSendWork({ ...sent, delivery: null }, 7, true)).toBe('nothing')

    // An attempt belongs to one invoice. Another invoice's send is untouched by
    // it, and is a first attempt of its own.
    expect(invoiceSendWork(sent, 8, true)).toBe('send')
    expect(invoiceSendWork(sent, 8, false)).toBe('send')
  })

  it('retires a send key only on the code that says its command committed', () => {
    const delivery = {
      commandId: 'web.invoice.delivery:1',
      recipients: [{ name: 'Accounts Payable', email: 'ap@example.test' }],
      cc: [],
      subject: 'Invoice #%invoice_number% from %company_name%',
      message: 'Hello,',
      sendMeACopy: false,
    }
    const attempting: InvoiceSendAttempt = {
      invoiceId: 7,
      transitionCommandId: 'web.invoice.send:1',
      sentVersion: null,
      delivery,
    }
    const sent: InvoiceSendAttempt = { ...attempting, sentVersion: 2 }

    // The failures that say nothing about whether the command committed keep
    // the key. Dropping it here is what re-sends the invoice.
    for (const code of [null, 'invoice_version_conflict', 'trigger_row_conflict']) {
      expect(invoiceSendFailure(attempting, 7, code)).toEqual({
        attempt: attempting,
        notice: null,
      })
      expect(invoiceSendFailure(sent, 7, code)).toEqual({ attempt: sent, notice: null })
    }

    // `command_id_reused` is the ledger refusing a key it already holds a row
    // for, so the command committed and the key is spent. Holding it refuses
    // every later submit, including a deliberate second send.
    const refusedSend = invoiceSendFailure(attempting, 7, 'command_id_reused')
    expect(refusedSend.attempt).toBeNull()
    expect(refusedSend.notice).toContain('already recorded as sent')
    expect(refusedSend.notice).toContain('records a second sent message')
    // The same code on the email half names the email, not the sent status.
    const refusedDelivery = invoiceSendFailure(sent, 7, 'command_id_reused')
    expect(refusedDelivery.attempt).toBeNull()
    expect(refusedDelivery.notice).toContain('already queued')
    expect(refusedDelivery.notice).toContain('a second email')

    // Another invoice's refusal is not this attempt's, and retiring the wrong
    // key would rearm a send that has already committed.
    expect(invoiceSendFailure(sent, 8, 'command_id_reused')).toEqual({
      attempt: sent,
      notice: null,
    })
    expect(invoiceSendFailure(null, 7, 'command_id_reused')).toEqual({
      attempt: null,
      notice: null,
    })
  })

  it('renders a stored recipient back into the line that parses to it', () => {
    const recipients = invoiceRecipients('Accounts Payable <AP@Example.Test>\nplain@example.test')
    expect(recipients.map(invoiceRecipientLine)).toEqual([
      'Accounts Payable <AP@Example.Test>',
      'plain@example.test',
    ])
    // A resumed send round-trips: what the box shows is what was confirmed.
    expect(invoiceRecipients(recipients.map(invoiceRecipientLine).join('\n'))).toEqual(recipients)
  })
})

describe('invoice edit plan', () => {
  const at = '2026-08-28T12:00:00.000Z'
  const editLine = (overrides: Partial<InvoiceLine> = {}): InvoiceLine =>
    ({
      id: 21,
      invoice_id: 7,
      position: 0,
      kind: 'Service',
      description: 'Platform support',
      quantity: 2,
      unit_price_cents: 1_500,
      amount_cents: 3_000,
      taxed: false,
      taxed2: false,
      project_id: 1,
      created_at: at,
      updated_at: at,
      ...overrides,
    }) as InvoiceLine
  const editable = (overrides: Partial<Invoice> = {}): Invoice =>
    invoice({
      id: 7,
      version: 4,
      subject: 'August services',
      purchase_order: null,
      notes: 'Thank you.\n',
      issue_date: '2026-08-01',
      due_date: '2026-08-31',
      payment_terms: 'net_30',
      tax_rate_ppm: 82_500,
      tax2_rate_ppm: null,
      discount_rate_ppm: null,
      line_items: [
        editLine(),
        editLine({ id: 22, position: 3, kind: 'Product', description: null, quantity: 1 }),
      ],
      ...overrides,
    })

  it('[unit] sends nothing for a page nobody touched, or touched and put back', () => {
    const base = editable()
    expect(invoiceEditPlan(base, invoiceDraft(base))).toEqual([])
    // Typed and restored, or changed only in the whitespace the save trims:
    // still nothing, because a write that changes nothing moves the version.
    const draft = invoiceDraft(base)
    expect(
      invoiceEditPlan(base, {
        ...draft,
        subject: ' August services ',
        notes: 'Thank you.',
        tax: '8.250',
        lines: draft.lines.map((row) => ({ ...row, rate: row.rate.replace('.00', '') })),
      }),
    ).toEqual([])
  })

  it('[unit] orders the commands: document, rates, then removed, changed and new lines', () => {
    const base = editable()
    const draft = invoiceDraft(base)
    const plan = invoiceEditPlan(base, {
      ...draft,
      subject: 'Revised',
      discount: '5',
      lines: [
        { ...draft.lines[0]!, quantity: '3' },
        { ...draft.lines[1]!, removed: true },
        {
          ...draft.lines[0]!,
          key: 'new-1',
          lineId: null,
          kind: 'Consulting',
          description: '  Tenth of an hour  ',
          quantity: '0.1',
          rate: '1.05',
          projectId: '',
        },
        {
          ...draft.lines[0]!,
          key: 'new-2',
          lineId: null,
          projectId: '9',
        },
      ],
    })
    expect(plan.map((step) => step.kind)).toEqual([
      'header',
      'rates',
      'line-delete',
      'line-update',
      'line-create',
      'line-create',
    ])
    expect(plan[0]).toMatchObject({
      edit: { subject: 'Revised', purchase_order: null, notes: 'Thank you.', payment_terms: 'net_30' },
    })
    expect(plan[1]).toMatchObject({
      edit: { tax_rate_ppm: 82_500, tax2_rate_ppm: null, discount_rate_ppm: 50_000 },
    })
    // New lines go after the last position the invoice holds, in page order.
    expect(plan[4]).toMatchObject({
      key: 'new-1',
      position: 4,
      edit: { kind: 'Consulting', description: 'Tenth of an hour', unit_price_cents: 105, project_id: null },
    })
    expect(plan[5]).toMatchObject({ key: 'new-2', position: 5, edit: { project_id: 9 } })
  })

  it('[unit] names the row a bad value is on, and the field the dates break', () => {
    const base = editable()
    const draft = invoiceDraft(base)
    expect(() =>
      invoiceEditPlan(base, {
        ...draft,
        lines: [draft.lines[0]!, { ...draft.lines[1]!, rate: '1.005' }],
      }),
    ).toThrow('Line 2: Rate must be a decimal amount with no more than two decimal places.')
    expect(() => invoiceEditPlan(base, { ...draft, dueDate: '2026-07-01' })).toThrow(
      'Due date cannot precede the issue date.',
    )
    expect(() => invoiceEditPlan(base, { ...draft, tax: '101' })).toThrow('Tax 1 cannot exceed 100%.')
    // A row nobody touched is not checked: it is not being sent.
    const odd = editable({ line_items: [editLine({ quantity: 1e-7 })] })
    expect(invoiceEditPlan(odd, invoiceDraft(odd))).toEqual([])
  })

  it('[unit] carries edits onto an invoice that moved, without sending back what was not edited', () => {
    const before = editable()
    const mine = invoiceDraft(before)
    const draft = {
      ...mine,
      subject: 'Mine',
      lines: [
        { ...mine.lines[0]!, description: 'My correction' },
        { ...mine.lines[1]!, quantity: '5' },
        { ...mine.lines[0]!, key: 'new-1', lineId: null, kind: 'Extra' },
      ],
    }
    const after = editable({
      version: 5,
      purchase_order: 'PO-2',
      line_items: [
        editLine({ quantity: 3, updated_at: '2026-08-29T00:00:00.000Z' }),
        editLine({ id: 30, position: 4, kind: 'Added elsewhere' }),
      ],
    })
    const rebased = invoiceDraftRebase(draft, before, after)
    // Typed here: kept. Not typed here: the newer value.
    expect(rebased.subject).toBe('Mine')
    expect(rebased.purchaseOrder).toBe('PO-2')
    expect(rebased.lines.map((row) => [row.key, row.lineId, row.description, row.quantity])).toEqual([
      ['line-21', 21, 'My correction', '3'],
      ['line-30', 30, 'Platform support', '2'],
      // Line 22 went elsewhere after it was edited here: kept, as a new line to
      // review, rather than vanishing with the edit.
      ['line-22', null, '', '5'],
      ['new-1', null, 'Platform support', '2'],
    ])
    // And what goes out next is the edits, at the new version's values.
    const plan = invoiceEditPlan(after, rebased)
    expect(plan.map((step) => step.kind)).toEqual([
      'header',
      'line-update',
      'line-create',
      'line-create',
    ])
    expect(plan[0]).toMatchObject({ edit: { subject: 'Mine', purchase_order: 'PO-2' } })
  })
})

describe('invoice email attachments', () => {
  const preference = (
    overrides: Partial<InvoiceDocumentPreferenceEnvelope['data']> = {},
  ): InvoiceDocumentPreferenceEnvelope['data'] => ({
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

  it('[unit] opens on what the invoice would do anyway', () => {
    expect(
      invoiceAttachmentsEffective(
        preference({ effective: true, effective_journal: 'summary', effective_journal_formats: ['csv'] }),
      ),
    ).toEqual({ pdf: true, files: false, append: false, journal: 'summary', journalFormats: ['csv'] })
    // `true` is not a level: the worker attaches nothing for it, so neither does the box.
    expect(invoiceAttachmentsEffective(preference({ effective_journal: true })).journal).toBe(false)
  })

  it('[unit] writes only what changed, and hands a choice back to the organization when it matches', () => {
    const base = preference()
    const unchanged = invoiceAttachmentsEffective(base)
    expect(invoiceAttachmentChanges(base, unchanged, true)).toBeNull()
    expect(
      invoiceAttachmentChanges(
        base,
        { pdf: true, files: true, append: true, journal: 'detailed', journalFormats: ['pdf', 'xlsx'] },
        true,
      ),
    ).toEqual({
      attach_pdf: true,
      attach_files: true,
      append_pdfs: true,
      attach_journal: 'detailed',
      journal_formats: ['pdf', 'xlsx'],
    })
    // The invoice attached its PDF on its own say-so; unticking it lands back
    // on the organization's answer, so the invoice follows it again.
    const pinned = preference({ attach_pdf: true, effective: true })
    expect(
      invoiceAttachmentChanges(pinned, { ...invoiceAttachmentsEffective(pinned), pdf: false }, true),
    ).toEqual({ attach_pdf: null })
    // No files to attach, no files written, whatever the box says.
    expect(invoiceAttachmentChanges(base, { ...unchanged, files: true }, false)).toBeNull()
    // The same files in another order are the same files.
    const reportOn = preference({ effective_journal: 'detailed', effective_journal_formats: ['pdf', 'csv'] })
    expect(
      invoiceAttachmentChanges(
        reportOn,
        { ...invoiceAttachmentsEffective(reportOn), journalFormats: ['csv', 'pdf'] },
        true,
      ),
    ).toBeNull()
  })

  it("[unit] hands a choice back to the client's rule, not past it, when it matches", () => {
    // The client binds its purchase order into every invoice; this invoice
    // said no, and ticking the box again follows the client once more.
    const clientRule = preference({
      append_pdfs: false,
      client_append_pdfs: true,
      effective_append_pdfs: false,
    })
    expect(
      invoiceAttachmentChanges(
        clientRule,
        { ...invoiceAttachmentsEffective(clientRule), append: true },
        true,
      ),
    ).toEqual({ append_pdfs: null })
    // And a client that sends no PDF is overridden by an invoice that does.
    const noPdf = preference({ client_attach_pdf: false, organization_attach_pdf: true })
    expect(
      invoiceAttachmentChanges(noPdf, { ...invoiceAttachmentsEffective(noPdf), pdf: true }, true),
    ).toEqual({ attach_pdf: true })
  })

  it('[unit] refuses an hours report with no files to send it as', () => {
    expect(() =>
      invoiceAttachmentChanges(
        preference(),
        { pdf: false, files: false, append: false, journal: 'summary', journalFormats: [] },
        true,
      ),
    ).toThrow('Choose at least one file for the hours report.')
  })
})

describe('a flat fee covering tracked time', () => {
  const fee = { description: ' Monthly retainer ', quantity: '1', unitPrice: '15000.00' }
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

  it('[unit] reads a limit in hours as plain hours or the duration forms', () => {
    expect(invoiceBandCeilingSeconds('100')).toBe(360_000)
    expect(invoiceBandCeilingSeconds(' 99.5 ')).toBe(358_200)
    expect(invoiceBandCeilingSeconds('99h30m')).toBe(358_200)
    expect(invoiceBandCeilingSeconds('90m')).toBe(5_400)
    for (const refused of ['', 'ten', '0', '-5', '1.5x']) {
      expect(() => invoiceBandCeilingSeconds(refused)).toThrow(
        'Enter the limit in hours, as 100, 99.5 or 99h30m.',
      )
    }
  })

  it('[unit] turns the fee and its terms into the request a band sends', () => {
    expect(
      invoiceBandTerms({
        lines: [fee, { description: '', quantity: '2.5', unitPrice: '-100' }],
        claimMode: 'all',
        ceilingUnit: 'hours',
        ceiling: '40',
        overageSummary: 'task',
      }),
    ).toStrictEqual({
      // Everything is covered, so a limit left in the form is not sent.
      line_items: [
        { kind: 'Service', description: 'Monthly retainer', quantity: 1, unit_price_cents: 1_500_000 },
        { kind: 'Service', description: null, quantity: 2.5, unit_price_cents: -10_000 },
      ],
      claim_mode: 'all',
    })
    expect(
      invoiceBandTerms({
        lines: [fee],
        claimMode: 'ceiling',
        ceilingUnit: 'value',
        ceiling: '12500.50',
        overageSummary: 'detailed',
      }),
    ).toStrictEqual({
      line_items: [
        { kind: 'Service', description: 'Monthly retainer', quantity: 1, unit_price_cents: 1_500_000 },
      ],
      claim_mode: 'ceiling',
      claim_ceiling_cents: 1_250_050,
      overage_summary_type: 'detailed',
    })
    const ceiling = { claimMode: 'ceiling', ceilingUnit: 'value', overageSummary: 'people' } as const
    expect(() => invoiceBandTerms({ ...ceiling, lines: [], ceiling: '1' })).toThrow(
      'Add at least one fee line.',
    )
    expect(() =>
      invoiceBandTerms({ ...ceiling, lines: [fee, { ...fee, quantity: 'two' }], ceiling: '1' }),
    ).toThrow('Fee line 2: Quantity must be a plain decimal number.')
    expect(() => invoiceBandTerms({ ...ceiling, lines: [fee], ceiling: '0.00' })).toThrow(
      'The limit must be more than zero.',
    )
    expect(() =>
      invoiceBandTerms({ ...ceiling, lines: [fee], ceiling: '1', overageSummary: '' }),
    ).toThrow('Choose how the hours past the limit are grouped.')
  })

  it('[unit] previews no more than the uninvoiced totals can stand behind', () => {
    const waiting = { seconds: 369_900, cents: 1_541_250, unpricedEntries: 0 }
    expect(invoiceBandPreview(waiting, 'all', null, usd)).toBe(
      '102.75 h uninvoiced in the period, all of it covered by the fee.',
    )
    expect(
      invoiceBandPreview(waiting, 'ceiling', { unit: 'seconds', value: 396_000 }, usd),
    ).toBe('102.75 h uninvoiced in the period, all of it within the 110.00 h limit.')
    expect(
      invoiceBandPreview(waiting, 'ceiling', { unit: 'cents', value: 2_000_000 }, usd),
    ).toBe(
      '102.75 h uninvoiced in the period, worth $15412.50 at list, all of it within the $20000.00 limit.',
    )
    // Money the viewer may not see is not previewed as if it were zero.
    expect(
      invoiceBandPreview({ ...waiting, cents: null }, 'ceiling', { unit: 'cents', value: 100 }, usd),
    ).toBe(
      '102.75 h uninvoiced in the period; the fee covers work worth up to $1.00 at list, oldest first.',
    )
    expect(
      invoiceBandPreview({ seconds: 0, cents: 0, unpricedEntries: 0 }, 'ceiling', null, usd),
    ).toBe('Nothing is uninvoiced on these projects in the period; the fee stands on its own.')
  })
})
