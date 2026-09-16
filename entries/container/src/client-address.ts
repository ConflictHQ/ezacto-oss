/**
 * Which address the rate limiter should count a request against.
 *
 * #729. The container sets `cf-connecting-ip` from the TCP peer, and the
 * self-host guide tells operators to publish on `127.0.0.1:3000` behind Caddy,
 * nginx or Traefik. In that layout the peer is always the proxy, so every
 * visitor shares one bucket: ten sign-in attempts per fifteen minutes for the
 * whole instance, and one careless tab locks everybody out.
 *
 * `X-Forwarded-For` is the obvious fix and is also forgeable, so it is opt-in.
 * An operator who knows how many proxies sit in front says so, and we count
 * that many entries in from the right -- the rightmost entry is the one the
 * nearest trusted proxy appended, and anything further left is whatever the
 * client chose to send. Zero, the default, ignores the header entirely and
 * keeps today's behaviour, which is wrong for a proxied deployment but never
 * lets a caller pick their own bucket.
 */

/** Conservative: an address we cannot parse is not an address we will trust. */
const looksLikeAddress = (value: string): boolean => {
  const candidate = value.trim()
  if (candidate === '') return false
  // IPv4, optionally with a port, and bracketed or bare IPv6.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/u.test(candidate)) return true
  if (/^\[[0-9a-fA-F:.]+\](:\d{1,5})?$/u.test(candidate)) return true
  return /^[0-9a-fA-F:]+$/u.test(candidate) && candidate.includes(':')
}

/** Strip a port and brackets so one client is one bucket across connections. */
const bareAddress = (value: string): string => {
  const candidate = value.trim()
  const bracketed = /^\[([^\]]+)\]/u.exec(candidate)
  if (bracketed !== null) return bracketed[1]
  // Only strip a trailing :port from IPv4; a bare IPv6 is all colons.
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/u.exec(candidate)
  return withPort === null ? candidate : withPort[1]
}

export const clientAddress = (
  forwardedFor: string | null,
  socketAddress: string | undefined,
  trustedProxyHops: number,
): string => {
  const fallback = socketAddress ?? 'unknown-client'
  if (trustedProxyHops <= 0 || forwardedFor === null) return fallback
  const entries = forwardedFor
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  // Count in from the right: the rightmost entry was appended by the nearest
  // proxy, so with one trusted hop that entry is the client it saw.
  const chosen = entries[entries.length - trustedProxyHops]
  if (chosen === undefined || !looksLikeAddress(chosen)) return fallback
  return bareAddress(chosen)
}
