import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** Instance-specific, purpose-separated digests; never expose through a public API. */
export const accountClosureDigest = (
  secret: string,
  kind: 'email' | 'provider' | 'review',
  value: string,
): string =>
  bytesToHex(
    hmac(
      sha256,
      hexToBytes(secret),
      utf8ToBytes(JSON.stringify(['account-closure-v1', kind, value])),
    ),
  )
export const closedAccountProviderKey = (provider: string, subject: string): string =>
  JSON.stringify([provider, subject])
