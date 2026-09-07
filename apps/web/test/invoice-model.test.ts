import type { Invoice, InvoiceMessage, InvoicePayment, Whoami } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  interpolateInvoiceTemplate,
  invoiceCanMarkSent,
  invoiceCanEditLines,
  invoiceCanRecordPayment,
  invoiceIdFromPathname,
  invoiceIdentityCanRead,
  invoiceIdentityCanWrite,
  invoiceMessageLabel,
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
  invoicePeriod,
  invoiceProfileHasAccess,
  invoiceRecipients,
  invoiceReminderDate,
  invoicePlannedReminder,
  invoiceStateLabel,
} from '../src/invoices/model.js'

const invoice = (overrides: Partial<Invoice> = {}): Invoice =>
  ({
    state: 'draft',
    close_reason: null,
    sent_at: null,
    period_start: null,
    period_end: null,
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

  it('[unit] accepts only a positive safe invoice id in the detail path', () => {
    expect(invoiceIdFromPathname('/invoices/42')).toBe(42)
    expect(invoiceIdFromPathname('/invoices/42/')).toBe(42)
    expect(invoiceIdFromPathname('/invoices/0')).toBeNull()
    expect(invoiceIdFromPathname('/invoices/-1')).toBeNull()
    expect(invoiceIdFromPathname('/invoices/12/edit')).toBeNull()
    expect(invoiceIdFromPathname('/invoices/9007199254740992')).toBeNull()
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
})
