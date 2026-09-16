import { describe, expect, it } from 'vitest'
import { clientAddress } from '../src/client-address.js'

/**
 * #729. Behind the reverse proxy the self-host guide recommends, the TCP peer
 * is always the proxy, so every visitor shared one rate-limit bucket: ten
 * sign-in attempts per fifteen minutes for the entire instance.
 *
 * X-Forwarded-For fixes that and is also forgeable, so trusting it is opt-in
 * and the default must stay closed.
 */
describe('clientAddress', () => {
  const socket = '10.0.0.7'

  describe('with no trusted proxy (the default)', () => {
    it('ignores the header entirely, however tempting it looks', () => {
      expect(clientAddress('203.0.113.9', socket, 0)).toBe(socket)
    })

    it('[security] cannot be talked into a different bucket by a forged header', () => {
      // Unproxied, this header is pure caller input. A caller who can choose
      // their own bucket has no rate limit at all.
      expect(clientAddress('1.1.1.1, 2.2.2.2, 3.3.3.3', socket, 0)).toBe(socket)
    })
  })

  describe('with one trusted proxy', () => {
    it('takes the address the proxy appended, not the first in the list', () => {
      // The client may send anything; the rightmost entry is what our proxy saw.
      expect(clientAddress('1.1.1.1, 203.0.113.9', socket, 1)).toBe('203.0.113.9')
    })

    it('[security] a forged left-hand entry cannot displace the proxy entry', () => {
      expect(clientAddress('99.99.99.99, 203.0.113.9', socket, 1)).toBe('203.0.113.9')
    })

    it('separates two visitors arriving down the same socket', () => {
      const first = clientAddress('203.0.113.9', socket, 1)
      const second = clientAddress('203.0.113.10', socket, 1)
      expect(first).not.toBe(second)
    })
  })

  describe('with two trusted proxies', () => {
    it('counts in from the right by that many hops', () => {
      expect(clientAddress('203.0.113.9, 10.1.1.1, 10.1.1.2', socket, 2)).toBe('10.1.1.1')
    })
  })

  describe('falling back', () => {
    it('uses the socket when the header is absent', () => {
      expect(clientAddress(null, socket, 1)).toBe(socket)
    })

    it('uses the socket when there are fewer entries than claimed hops', () => {
      expect(clientAddress('203.0.113.9', socket, 3)).toBe(socket)
    })

    it('[security] refuses an entry that is not an address', () => {
      // A parseable bucket key is the point; arbitrary text would let a caller
      // mint unlimited buckets.
      expect(clientAddress('not-an-address', socket, 1)).toBe(socket)
      expect(clientAddress('<script>', socket, 1)).toBe(socket)
    })

    it('uses the fallback string when there is no socket either', () => {
      expect(clientAddress(null, undefined, 0)).toBe('unknown-client')
    })
  })

  describe('normalising', () => {
    it('drops a port so one client is one bucket across connections', () => {
      expect(clientAddress('203.0.113.9:51234', socket, 1)).toBe('203.0.113.9')
    })

    it('unwraps a bracketed IPv6 address', () => {
      expect(clientAddress('[2001:db8::1]:4430', socket, 1)).toBe('2001:db8::1')
    })

    it('keeps a bare IPv6 address, which is all colons and no port', () => {
      expect(clientAddress('2001:db8::1', socket, 1)).toBe('2001:db8::1')
    })

    it('tolerates the spacing real proxies emit', () => {
      expect(clientAddress('1.1.1.1,203.0.113.9', socket, 1)).toBe('203.0.113.9')
      expect(clientAddress('1.1.1.1 ,  203.0.113.9 ', socket, 1)).toBe('203.0.113.9')
    })
  })
})
