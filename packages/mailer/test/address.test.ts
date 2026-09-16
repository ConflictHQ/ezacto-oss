import { describe, expect, it } from 'vitest'
import { formatAddress } from '../src/address.js'

/**
 * #738. A display name is arbitrary user text: a client contact's name, a
 * user's own name, whatever the organization typed. Interpolated raw into
 * `${name} <${email}>` it is not data but syntax, and the header parser will
 * believe it.
 */
describe('formatAddress', () => {
  it('leaves an ordinary name unquoted, because nothing needs escaping', () => {
    expect(formatAddress('ada@example.com', 'Ada Lovelace')).toBe('Ada Lovelace <ada@example.com>')
  })

  it('is the bare mailbox when there is no name', () => {
    expect(formatAddress('ada@example.com')).toBe('ada@example.com')
    expect(formatAddress('ada@example.com', '   ')).toBe('ada@example.com')
  })

  it('[security] a comma cannot split one recipient into two', () => {
    const value = formatAddress('ada@example.com', 'Ng, Avery')
    expect(value).toBe('"Ng, Avery" <ada@example.com>')
    // One mailbox, whatever a header parser does with the commas inside quotes.
    expect(value.split('@').length - 1).toBe(1)
  })

  it('[security] angle brackets cannot move the mailbox', () => {
    const value = formatAddress('ada@example.com', 'Ada <attacker@evil.example>')
    expect(value).toBe('"Ada <attacker@evil.example>" <ada@example.com>')
    expect(value.endsWith('<ada@example.com>')).toBe(true)
  })

  it('[security] a quote cannot close the quoted-string early', () => {
    expect(formatAddress('ada@example.com', 'Ada" <attacker@evil.example>, "x')).toBe(
      '"Ada\\" <attacker@evil.example>, \\"x" <ada@example.com>',
    )
  })

  it('[security] a backslash is escaped rather than escaping what follows', () => {
    expect(formatAddress('ada@example.com', 'back\\slash')).toBe('"back\\\\slash" <ada@example.com>')
  })

  it('[security] control characters are dropped, since a header cannot carry them', () => {
    expect(formatAddress('ada@example.com', 'Ada\r\nBcc: attacker@evil.example')).toBe(
      '"AdaBcc: attacker@evil.example" <ada@example.com>',
    )
  })

  it('quotes the other RFC 5322 specials too', () => {
    for (const name of ['a:b', 'a;b', 'a@b', 'a(b)', 'a[b]']) {
      expect(formatAddress('ada@example.com', name).startsWith('"')).toBe(true)
    }
  })
})
