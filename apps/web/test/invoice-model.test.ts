import type { Invoice, InvoiceMessage, InvoicePayment } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  invoiceIdFromPathname,
  invoiceMessageLabel,
  invoicePaymentDate,
  invoicePeriod,
  invoiceProfileHasAccess,
  invoiceStateLabel,
} from '../src/invoices/model.js'

const invoice = (overrides: Partial<Invoice> = {}): Invoice =>
  ({
    state: 'draft',
    close_reason: null,
    period_start: null,
    period_end: null,
    ...overrides,
  }) as Invoice

describe('invoice workspace model', () => {
  it('[security] restricts invoices to finance-capable profiles', () => {
    expect(invoiceProfileHasAccess('member')).toBe(false)
    expect(invoiceProfileHasAccess('project_manager')).toBe(false)
    expect(invoiceProfileHasAccess('people_admin')).toBe(false)
    expect(invoiceProfileHasAccess('accounting')).toBe(true)
    expect(invoiceProfileHasAccess('executive_manager')).toBe(true)
    expect(invoiceProfileHasAccess('administrator')).toBe(true)
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
  })
})
