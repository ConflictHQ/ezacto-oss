import type { InvoiceStateDatabase } from './invoice-state.js'
import { atomicStatements } from './atomic-statements.js'

export const writePayloadHash = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), value => value.toString(16).padStart(2, '0')).join('')

export interface WritePayloadChunk { readonly position: number; readonly bytes: number; readonly data: string }
export const encodeWritePayload = async (body: string): Promise<{ hash: string; bytes: number; chunks: readonly WritePayloadChunk[] }> => {
  const bytes = new TextEncoder().encode(body), chunks: WritePayloadChunk[] = []
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    const part = bytes.subarray(offset, offset + 65_536), pieces: string[] = []
    for (let at = 0; at < part.length; at += 8192) pieces.push(String.fromCharCode(...part.subarray(at, at + 8192)))
    chunks.push({ position: chunks.length, bytes: part.length, data: btoa(pieces.join('')) })
  }
  return { hash: await writePayloadHash(bytes), bytes: bytes.length, chunks }
}

/** Page bounded rows, preserve UTF-8 across chunk boundaries, and verify the
 * sealed byte count and digest before any request may reach a provider.
 */
export const readWritePayload = async (database: InvoiceStateDatabase, input: {
  direction: 'request' | 'response'; id: string; hash: string; bytes: number; chunks: number
}): Promise<string> => {
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 2 || !Number.isSafeInteger(input.chunks) || input.chunks < 1) {
    throw new Error('Invalid QuickBooks write payload manifest')
  }
  const table = input.direction === 'request' ? 'quickbooks_write_request_chunks' : 'quickbooks_write_response_chunks'
  const key = input.direction === 'request' ? 'effect_id' : 'attempt_id'
  const bytes = new Uint8Array(input.bytes)
  let offset = 0, position = 0
  while (position < input.chunks) {
    const result = await atomicStatements(database, [{ text: `SELECT position,bytes,data FROM ${table}
      WHERE ${key}=? AND position>=? ORDER BY position LIMIT 32`, params: [input.id,position] }])
    if (!result[0]?.length) throw new Error('Incomplete QuickBooks write payload')
    for (const row of result[0]) {
      if (row.position !== position || typeof row.data !== 'string' || row.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.data)) {
        throw new Error('Invalid QuickBooks write payload chunk')
      }
      const part = atob(row.data)
      if (part.length !== row.bytes || offset + part.length > bytes.length || position >= input.chunks) throw new Error('Invalid QuickBooks write payload size')
      for (let index = 0; index < part.length; index += 1) bytes[offset + index] = part.charCodeAt(index)
      offset += part.length; position += 1
    }
  }
  if (offset !== bytes.length || await writePayloadHash(bytes) !== input.hash) throw new Error('QuickBooks write payload digest mismatch')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
