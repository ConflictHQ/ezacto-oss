import { describe, expect, it } from 'vitest'
import {
  assertInvoiceAddressCount,
  invoiceAddressLine,
  invoiceAddressLines,
  parseInvoiceAddressLines,
} from '../src/invoice-addresses.js'

describe('invoice addresses typed one per line', () => {
  it('[unit] reads a bare address and a named one, and skips the blank lines between', () => {
    // The Send dialog's format, so a list typed on a client is typed the way
    // the dialog it fills is typed.
    expect(
      parseInvoiceAddressLines(
        'ap@example.com\n\n  Dana Reyes <dana@example.test>  \r\n',
        'To',
      ),
    ).toEqual([
      { name: '', email: 'ap@example.com' },
      { name: 'Dana Reyes', email: 'dana@example.test' },
    ])
    // An empty box is no addresses: whether one is required is the caller's.
    expect(parseInvoiceAddressLines('  \n\t\n', 'Cc')).toEqual([])
  })

  it('[unit] keeps an address listed twice once, whatever its case, as the Send dialog does', () => {
    expect(
      parseInvoiceAddressLines('ap@example.com\nAccounts Payable <AP@Example.com>', 'To'),
    ).toEqual([{ name: '', email: 'ap@example.com' }])
  })

  it('[unit] names the list and the line that is not an address', () => {
    expect(() => parseInvoiceAddressLines('ap@example.com\nnot-an-address', 'Cc')).toThrow(
      'Cc: “not-an-address” is not an email address. Write email@example.com or Name <email@example.com>.',
    )
    // No dot after the @, the route's pattern refuses it too.
    expect(() => parseInvoiceAddressLines('Dana <dana@example>', 'To')).toThrow(
      'To: “Dana <dana@example>” is not an email address.',
    )
    // An unclosed bracket is not a named address with a typo in it.
    expect(() => parseInvoiceAddressLines('Dana <dana@example.test', 'To')).toThrow(
      'is not an email address',
    )
  })

  it('[unit] holds a name and an address to the lengths the route stores', () => {
    expect(() =>
      parseInvoiceAddressLines(`${'N'.repeat(201)} <ap@example.com>`, 'To'),
    ).toThrow('the name in')
    expect(parseInvoiceAddressLines(`${'N'.repeat(200)} <ap@example.com>`, 'To')).toHaveLength(1)
    expect(() => parseInvoiceAddressLines(`${'a'.repeat(250)}@example.com`, 'To')).toThrow(
      'is not an email address',
    )
    // A control character in a name is refused there; here it is named.
    expect(() => parseInvoiceAddressLines('Dana\tReyes <dana@example.test>', 'To')).toThrow(
      'To: the name in “Dana\tReyes <dana@example.test>” must be plain text of at most 200 characters.',
    )
  })

  it('[unit] says a list is over its cap in the list’s own name', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => ({
      name: '',
      email: `finance${index}@example.com`,
    }))
    expect(() => assertInvoiceAddressCount(twenty, 'Always copy', 20)).not.toThrow()
    expect(() =>
      assertInvoiceAddressCount(
        [...twenty, { name: '', email: 'one-more@example.com' }],
        'Always copy',
        20,
      ),
    ).toThrow('Always copy can hold at most 20 addresses.')
  })

  it('[unit] writes each address back as the line it would be typed as', () => {
    const addresses = [
      { name: '', email: 'ap@example.com' },
      { name: 'Dana Reyes', email: 'dana@example.test' },
    ]
    expect(invoiceAddressLine(addresses[1]!)).toBe('Dana Reyes <dana@example.test>')
    expect(invoiceAddressLines(addresses)).toBe('ap@example.com\nDana Reyes <dana@example.test>')
    expect(parseInvoiceAddressLines(invoiceAddressLines(addresses), 'To')).toEqual(addresses)
  })
})
