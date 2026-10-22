import { calculateInvoiceLineAmountCents } from './invoice-state.js'

/** Reusable quote content deliberately has no customer, document or delivery identity. */
export interface EstimateContent {
  subject: string | null
  notes: string | null
  currency: string
  tax_rate_ppm: number | null
  tax2_rate_ppm: number | null
  discount_rate_ppm: number | null
  lines: Array<{
    kind: string
    description: string | null
    quantity: number
    unit_price_cents: number
    taxed: boolean
    taxed2: boolean
  }>
}
export class EstimateContentError extends Error {
  constructor(
    readonly code:
      | 'invalid_estimate_content'
      | 'estimate_template_conflict'
      | 'estimate_template_not_found'
      | 'estimate_draft_conflict',
    message: string,
  ) {
    super(message)
    this.name = 'EstimateContentError'
  }
}
const invalid = (message: string): never => {
  throw new EstimateContentError('invalid_estimate_content', message)
}
const object = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return invalid('Expected quote content object.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => !keys.includes(key)))
    invalid('Quote content contains an unsupported field.')
  return value
}
const text = (value: unknown, name: string, max: number, nullable = true): string | null => {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || value.length > max || (!nullable && value.trim() === ''))
    invalid(`${name} must be ${nullable ? 'null or ' : ''}text of at most ${max} characters.`)
  return value as string
}
export const estimateTemplateName = (raw: unknown): string => text(raw, 'name', 120, false)!.trim()
const rate = (value: unknown): number | null => {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000)
    invalid('Rates must be null or integer parts per million from 0 to 1000000.')
  return value as number
}
export const parseEstimateContent = (raw: unknown): EstimateContent => {
  const value = object(raw, [
    'subject',
    'notes',
    'currency',
    'tax_rate_ppm',
    'tax2_rate_ppm',
    'discount_rate_ppm',
    'lines',
  ])
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))
    invalid('Currency must be three uppercase letters.')
  if (!Array.isArray(value.lines) || value.lines.length === 0 || value.lines.length > 100)
    invalid('A quote needs 1 to 100 lines.')
  const lines = (value.lines as unknown[]).map((rawLine) => {
    const line = object(rawLine, [
      'kind',
      'description',
      'quantity',
      'unit_price_cents',
      'taxed',
      'taxed2',
    ])
    if (
      typeof line.quantity !== 'number' ||
      !Number.isFinite(line.quantity) ||
      Math.abs(line.quantity) > Number.MAX_SAFE_INTEGER
    )
      invalid('Line quantity must be a bounded finite number.')
    if (typeof line.taxed !== 'boolean' || typeof line.taxed2 !== 'boolean')
      invalid('Line tax flags must be booleans.')
    try {
      calculateInvoiceLineAmountCents(line.quantity as number, line.unit_price_cents as number)
    } catch {
      invalid('Line amount exceeds bounded integer cents.')
    }
    return {
      kind: text(line.kind, 'kind', 100, false)!,
      description: text(line.description, 'description', 10000),
      quantity: line.quantity as number,
      unit_price_cents: line.unit_price_cents as number,
      taxed: line.taxed as boolean,
      taxed2: line.taxed2 as boolean,
    }
  })
  const content = {
    subject: text(value.subject, 'subject', 500),
    notes: text(value.notes, 'notes', 20000),
    currency: value.currency as string,
    tax_rate_ppm: rate(value.tax_rate_ppm),
    tax2_rate_ppm: rate(value.tax2_rate_ppm),
    discount_rate_ppm: rate(value.discount_rate_ppm),
    lines,
  }
  estimateContentTotals(content)
  return content
}
const bounded = (value: bigint): number => {
  if (value < -9_000_000_000_000n || value > 9_000_000_000_000n)
    invalid('Quote amount exceeds bounded integer cents.')
  return Number(value)
}
/** D21: half away from zero; discount first, independent parallel taxes. */
export const estimateContentTotals = (content: EstimateContent) => {
  const amounts = content.lines.map((line) =>
    calculateInvoiceLineAmountCents(line.quantity, line.unit_price_cents),
  )
  const sum = (tax?: 'taxed' | 'taxed2') =>
    amounts.reduce(
      (total, amount, i) => total + (!tax || content.lines[i]![tax] ? BigInt(amount) : 0n),
      0n,
    )
  const apply = (base: bigint, ppm: number | null) => {
    const product = base * BigInt(ppm ?? 0),
      magnitude = product < 0n ? -product : product
    const rounded = (magnitude + 500_000n) / 1_000_000n
    return product < 0n ? -rounded : rounded
  }
  const subtotal = sum(),
    discount = apply(subtotal, content.discount_rate_ppm)
  const tax = apply(
    sum('taxed') - apply(sum('taxed'), content.discount_rate_ppm),
    content.tax_rate_ppm,
  )
  const tax2 = apply(
    sum('taxed2') - apply(sum('taxed2'), content.discount_rate_ppm),
    content.tax2_rate_ppm,
  )
  return {
    amounts,
    amount_cents: bounded(subtotal - discount + tax + tax2),
    discount_amount_cents: bounded(discount),
    tax_amount_cents: bounded(tax),
    tax2_amount_cents: bounded(tax2),
  }
}
export interface EstimateTemplate {
  id: string
  name: string
  version: number
  archived: boolean
  content: EstimateContent
  created_at: string
  updated_at: string
}
