import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
const encoder = new TextEncoder()
export const sha256Hex = (value: string | Uint8Array): string =>
  bytesToHex(sha256(typeof value === 'string' ? encoder.encode(value) : value))
export const utf8ByteLength = (value: string): number => encoder.encode(value).length
