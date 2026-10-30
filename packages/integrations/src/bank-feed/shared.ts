/** Read-only bank transport. Provider bodies and credentials never enter errors. */
export class BankFeedError extends Error {
  constructor(
    readonly code: 'configuration' | 'cursor' | 'transport' | 'provider' | 'response',
    readonly status?: number,
  ) {
    super(`Bank feed ${code}${status === undefined ? '' : ` (${status})`}`)
    this.name = 'BankFeedError'
  }
}
export type { BankDepositObservation as FeedObservation } from '@ezacto/core'
import type { BankDepositObservation } from '@ezacto/core'
export type FeedObservations = Record<string, BankDepositObservation>
export interface ReadFeedOptions {
  token: string
  currency: string
  intervalStart: string
  intervalEnd: string
  environment?: 'production' | 'sandbox'
  fetchImplementation?: typeof fetch
}
export const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BankFeedError('response')
  return value as Record<string, unknown>
}
export const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value))
    throw new BankFeedError('response')
  return value
}
export const optionalText = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 4000) throw new BankFeedError('response')
  return value.trim() || null
}
export const timestamp = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    throw new BankFeedError('response')
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== value.slice(0, 10) ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    throw new BankFeedError('response')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new BankFeedError('response')
  return date.toISOString()
}
/** Never round monetary input; unsupported fractions fail rather than create money. */
export const cents = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BankFeedError('response')
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value))
  if (!match) throw new BankFeedError('response')
  const amount = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || amount > 9_000_000_000_000)
    throw new BankFeedError('response')
  return match[1] === '-' ? -amount : amount
}
export const configuration = (
  options: Readonly<ReadFeedOptions>,
): { start: string; end: string } => {
  if (!options.token.trim() || !/^[A-Z]{3}$/.test(options.currency))
    throw new BankFeedError('configuration')
  // The neutral contract is cents, not arbitrary currency minor units.
  if (
    !Intl.supportedValuesOf('currency').includes(options.currency) ||
    new Intl.NumberFormat('en', { style: 'currency', currency: options.currency }).resolvedOptions()
      .maximumFractionDigits !== 2
  )
    throw new BankFeedError('configuration')
  let start: string
  let end: string
  try {
    start = timestamp(options.intervalStart)
    end = timestamp(options.intervalEnd)
  } catch {
    throw new BankFeedError('configuration')
  }
  if (start >= end || Date.parse(end) - Date.parse(start) > 31 * 86_400_000)
    throw new BankFeedError('configuration')
  return { start, end }
}
export const readJson = async (url: URL, options: Readonly<ReadFeedOptions>): Promise<unknown> => {
  let response: Response
  try {
    response = await (options.fetchImplementation ?? fetch)(url, {
      method: 'GET',
      // workerd accepts manual/follow, not error; !response.ok below rejects 3xx.
      redirect: 'manual',
      headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new BankFeedError('transport')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new BankFeedError('provider', response.status)
  }
  const maximum = 2 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel().catch(() => undefined)
    throw new BankFeedError('response')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new BankFeedError('response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new BankFeedError('response')
      }
      chunks.push(result.value)
    }
    const joined = new Uint8Array(size)
    let position = 0
    for (const chunk of chunks) {
      joined.set(chunk, position)
      position += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown
  } catch (error) {
    if (error instanceof BankFeedError) throw error
    throw new BankFeedError('response')
  } finally {
    reader.releaseLock()
  }
}
export const cursorOf = (scope: string, key: string): string => JSON.stringify({ v: 1, scope, key })
export const cursorKey = (cursor: string | null, scope: string): string | null => {
  if (cursor === null) return null
  try {
    if (cursor.length > 1200) throw new Error()
    const parsed = object(JSON.parse(cursor) as unknown)
    if (
      parsed.v !== 1 ||
      parsed.scope !== scope ||
      typeof parsed.key !== 'string' ||
      parsed.key.length > 200
    )
      throw new Error()
    return parsed.key
  } catch {
    throw new BankFeedError('cursor')
  }
}
