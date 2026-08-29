import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { percentageToRatePpm } from './invoice-payments.js'
import type * as schema from './schema.js'
import { estimateMessages } from './schema.js'
import type {
  EstimateDeliveryStatus,
  EstimateMessageEventType,
  EstimateRecipient,
} from './schema.js'

export type EstimateDatabase =
  BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export type Estimate = typeof schema.estimates.$inferSelect
export type EstimateLineItem = typeof schema.estimateLineItems.$inferSelect
export type EstimateMessage = typeof estimateMessages.$inferSelect
export type WritableEstimateMessageEvent = Exclude<EstimateMessageEventType, 'view' | 'invoice'>
export type SystemEstimateMessageEvent = Extract<EstimateMessageEventType, 'view' | 'invoice'>

type HarvestDecimal = string | number

export interface HarvestEstimateLinePayload {
  id: number
  kind: string
  description: string | null
  quantity: HarvestDecimal
  unit_price: HarvestDecimal
  amount: HarvestDecimal
  taxed: boolean
  taxed2: boolean
}

export interface HarvestEstimatePayload {
  id: number
  client: { id: number; name: string }
  line_items: readonly HarvestEstimateLinePayload[]
  creator: { id: number; name: string } | null
  client_key: string
  number: string
  purchase_order: string | null
  amount: HarvestDecimal
  tax: HarvestDecimal | null
  tax_amount: HarvestDecimal
  tax2: HarvestDecimal | null
  tax2_amount: HarvestDecimal
  discount: HarvestDecimal | null
  discount_amount: HarvestDecimal
  subject: string | null
  notes: string | null
  currency: string
  state: 'draft' | 'sent' | 'accepted' | 'declined'
  issue_date: string
  sent_at: string | null
  accepted_at: string | null
  declined_at: string | null
  created_at: string
  updated_at: string
}

export interface HarvestEstimateMessagePayload {
  id: number
  sent_by: string | null
  sent_by_email: string | null
  sent_from: string | null
  sent_from_email: string | null
  recipients: readonly EstimateRecipient[]
  subject: string | null
  body: string | null
  send_me_a_copy: boolean
  event_type: EstimateMessageEventType | null
  created_at: string
  updated_at: string
}

export interface HarvestEstimateItemCategoryPayload {
  id: number
  name: string
  created_at: string
  updated_at: string
}

export interface MappedHarvestEstimate {
  estimate: typeof schema.estimates.$inferInsert
  lineItems: Array<Omit<typeof schema.estimateLineItems.$inferInsert, 'estimateId'>>
}

const moneyUpperBound = 9_000_000_000_000
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const writableEvents = new Set<EstimateMessageEventType>(['send', 'accept', 'decline', 're-open'])
const systemEvents = new Set<EstimateMessageEventType>(['view', 'invoice'])
const deliveryStatuses = new Set<EstimateDeliveryStatus>([
  'queued',
  'sent',
  'bounced',
  'complained',
  'failed',
])

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalDate = (value: string, field: string): void => {
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`${field} must be a real canonical date`)
  }
}

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const match = timestampPattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical UTC timestamp`)
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? '').padEnd(3, '0')}Z`
  const milliseconds = Date.parse(normalized)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new RangeError(`${field} must be a real canonical UTC timestamp`)
  }
}

const assertNullableCanonicalTimestamp = (value: string | null, field: string): void => {
  if (value !== null) assertCanonicalTimestamp(value, field)
}

const assertNonblank = (value: string, field: string): void => {
  if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
}

const decimalText = (value: HarvestDecimal, field: string): string => {
  const text = typeof value === 'number' ? String(value) : value
  if (!decimalPattern.test(text)) throw new TypeError(`${field} must be a plain decimal`)
  return text
}

export const harvestMoneyToCents = (value: HarvestDecimal, field = 'money'): number => {
  const text = decimalText(value, field)
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [whole, fractional = ''] = unsigned.split('.')
  if (fractional.length > 2) {
    throw new RangeError(`${field} has more than two decimal places`)
  }
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2, '0'))
  const signed = negative ? -cents : cents
  if (!Number.isSafeInteger(signed) || Math.abs(signed) > moneyUpperBound) {
    throw new RangeError(`${field} is outside the supported money range`)
  }
  return signed
}

const harvestQuantity = (value: HarvestDecimal): number => {
  const parsed = Number(decimalText(value, 'line_items.quantity'))
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('line_items.quantity must be finite and bounded')
  }
  return parsed
}

const harvestRate = (value: HarvestDecimal | null, field: string): number | null => {
  if (value === null) return null
  return percentageToRatePpm(decimalText(value, field))
}

const assertCurrency = (value: string): void => {
  if (!/^[A-Z]{3}$/.test(value)) throw new TypeError('currency must be uppercase ISO 4217')
}

const assertRecipient = (recipient: EstimateRecipient, index: number): void => {
  if (
    typeof recipient !== 'object' ||
    recipient === null ||
    Array.isArray(recipient) ||
    Object.keys(recipient).some((key) => key !== 'name' && key !== 'email') ||
    !Object.hasOwn(recipient, 'name') ||
    !Object.hasOwn(recipient, 'email') ||
    typeof recipient.name !== 'string' ||
    typeof recipient.email !== 'string' ||
    recipient.email.trim().length === 0
  ) {
    throw new TypeError(`recipients[${index}] must contain exactly string name and email`)
  }
}

const validateRecipients = (recipients: readonly EstimateRecipient[]): EstimateRecipient[] => {
  if (!Array.isArray(recipients)) throw new TypeError('recipients must be an array')
  recipients.forEach(assertRecipient)
  return recipients.map(({ name, email }) => ({ name, email }))
}

/**
 * Pure Harvest-to-storage boundary. Native bearer keys are intentionally omitted;
 * the database generates a fresh client_key on insert.
 */
export const mapHarvestEstimatePayload = (
  source: HarvestEstimatePayload,
  resolution: { clientId: number; createdByUserId: number | null },
): MappedHarvestEstimate => {
  assertPositiveSafeInteger(source.id, 'estimate.id')
  assertPositiveSafeInteger(source.client.id, 'estimate.client.id')
  assertPositiveSafeInteger(resolution.clientId, 'clientId')
  if (resolution.createdByUserId !== null) {
    assertPositiveSafeInteger(resolution.createdByUserId, 'createdByUserId')
  }
  if (source.creator !== null) {
    assertPositiveSafeInteger(source.creator.id, 'estimate.creator.id')
    assertNonblank(source.creator.name, 'estimate.creator.name')
  }
  assertNonblank(source.number, 'estimate.number')
  assertCurrency(source.currency)
  assertCanonicalDate(source.issue_date, 'estimate.issue_date')
  assertNullableCanonicalTimestamp(source.sent_at, 'estimate.sent_at')
  assertNullableCanonicalTimestamp(source.accepted_at, 'estimate.accepted_at')
  assertNullableCanonicalTimestamp(source.declined_at, 'estimate.declined_at')
  assertCanonicalTimestamp(source.created_at, 'estimate.created_at')
  assertCanonicalTimestamp(source.updated_at, 'estimate.updated_at')

  const lineItems = source.line_items.map((line, position) => {
    assertPositiveSafeInteger(line.id, `line_items[${position}].id`)
    assertNonblank(line.kind, `line_items[${position}].kind`)
    return {
      harvestId: line.id,
      position,
      kind: line.kind,
      description: line.description,
      quantity: harvestQuantity(line.quantity),
      unitPriceCents: harvestMoneyToCents(line.unit_price, `line_items[${position}].unit_price`),
      amountCents: harvestMoneyToCents(line.amount, `line_items[${position}].amount`),
      taxed: line.taxed,
      taxed2: line.taxed2,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
    }
  })

  return {
    estimate: {
      harvestId: source.id,
      clientId: resolution.clientId,
      createdByUserId: resolution.createdByUserId,
      sourceCreatorId: source.creator?.id ?? null,
      sourceCreatorName: source.creator?.name ?? null,
      number: source.number,
      purchaseOrder: source.purchase_order,
      subject: source.subject,
      notes: source.notes,
      currency: source.currency,
      state: source.state,
      version: 0,
      issueDate: source.issue_date,
      sentAt: source.sent_at,
      acceptedAt: source.accepted_at,
      declinedAt: source.declined_at,
      taxRatePpm: harvestRate(source.tax, 'estimate.tax'),
      tax2RatePpm: harvestRate(source.tax2, 'estimate.tax2'),
      discountRatePpm: harvestRate(source.discount, 'estimate.discount'),
      amountCents: harvestMoneyToCents(source.amount, 'estimate.amount'),
      taxAmountCents: harvestMoneyToCents(source.tax_amount, 'estimate.tax_amount'),
      tax2AmountCents: harvestMoneyToCents(source.tax2_amount, 'estimate.tax2_amount'),
      discountAmountCents: harvestMoneyToCents(source.discount_amount, 'estimate.discount_amount'),
      createdAt: source.created_at,
      updatedAt: source.updated_at,
    },
    lineItems,
  }
}

export const mapHarvestEstimateMessagePayload = (
  source: HarvestEstimateMessagePayload,
  estimateId: number,
): typeof estimateMessages.$inferInsert => {
  assertPositiveSafeInteger(source.id, 'estimate_message.id')
  assertPositiveSafeInteger(estimateId, 'estimateId')
  assertCanonicalTimestamp(source.created_at, 'estimate_message.created_at')
  assertCanonicalTimestamp(source.updated_at, 'estimate_message.updated_at')
  if (
    source.event_type !== null &&
    !writableEvents.has(source.event_type) &&
    !systemEvents.has(source.event_type)
  ) {
    throw new TypeError('estimate_message.event_type is invalid')
  }
  const recipients = validateRecipients(source.recipients)
  if (source.event_type === 'send' && recipients.length === 0) {
    throw new TypeError('Harvest estimate send requires at least one recipient')
  }
  return {
    harvestId: source.id,
    estimateId,
    sentBy: source.sent_by,
    sentByEmail: source.sent_by_email,
    sentFrom: source.sent_from,
    sentFromEmail: source.sent_from_email,
    recipients,
    subject: source.subject,
    body: source.body,
    sendMeACopy: source.send_me_a_copy,
    eventType: source.event_type,
    deliveryStatus: null,
    providerMessageId: null,
    createdAt: source.created_at,
    updatedAt: source.updated_at,
  }
}

export const mapHarvestEstimateItemCategoryPayload = (
  source: HarvestEstimateItemCategoryPayload,
): typeof schema.estimateItemCategories.$inferInsert => {
  assertPositiveSafeInteger(source.id, 'estimate_item_category.id')
  assertNonblank(source.name, 'estimate_item_category.name')
  assertCanonicalTimestamp(source.created_at, 'estimate_item_category.created_at')
  assertCanonicalTimestamp(source.updated_at, 'estimate_item_category.updated_at')
  return {
    harvestId: source.id,
    name: source.name,
    createdAt: source.created_at,
    updatedAt: source.updated_at,
  }
}

interface MessageSnapshots {
  sentBy?: string | null
  sentByEmail?: string | null
  sentFrom?: string | null
  sentFromEmail?: string | null
}

export interface CreateEstimateMessageInput extends MessageSnapshots {
  estimateId: number
  recipients?: readonly EstimateRecipient[]
  subject?: string | null
  body?: string | null
  sendMeACopy?: boolean
  eventType: WritableEstimateMessageEvent | null
  createdAt: string
  updatedAt: string
}

export const createEstimateMessage = async (
  database: EstimateDatabase,
  input: CreateEstimateMessageInput,
): Promise<EstimateMessage> => {
  assertPositiveSafeInteger(input.estimateId, 'estimateId')
  assertCanonicalTimestamp(input.createdAt, 'createdAt')
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt')
  if (input.eventType !== null && !writableEvents.has(input.eventType)) {
    throw new TypeError('native estimate event must be send, accept, decline, or re-open')
  }
  const recipients = validateRecipients(input.recipients ?? [])
  if (input.eventType === 'send' && recipients.length === 0) {
    throw new TypeError('native estimate send requires at least one recipient')
  }

  const [created] = await database
    .insert(estimateMessages)
    .values({
      estimateId: input.estimateId,
      sentBy: input.sentBy ?? null,
      sentByEmail: input.sentByEmail ?? null,
      sentFrom: input.sentFrom ?? null,
      sentFromEmail: input.sentFromEmail ?? null,
      recipients,
      subject: input.subject ?? null,
      body: input.body ?? null,
      sendMeACopy: input.sendMeACopy ?? false,
      eventType: input.eventType,
      deliveryStatus: input.eventType === 'send' ? 'queued' : null,
      providerMessageId: null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning()
  if (!created) throw new Error('estimate message creation did not return a row')
  return created
}

export interface RecordSystemEstimateEventInput extends MessageSnapshots {
  estimateId: number
  eventType: SystemEstimateMessageEvent
  createdAt: string
}

/** Trusted service seam for audit events that the native write operation rejects. */
export const recordSystemEstimateEvent = async (
  database: EstimateDatabase,
  input: RecordSystemEstimateEventInput,
): Promise<EstimateMessage> => {
  assertPositiveSafeInteger(input.estimateId, 'estimateId')
  assertCanonicalTimestamp(input.createdAt, 'createdAt')
  if (!systemEvents.has(input.eventType)) {
    throw new TypeError('system estimate event must be view or invoice')
  }
  const [created] = await database
    .insert(estimateMessages)
    .values({
      estimateId: input.estimateId,
      sentBy: input.sentBy ?? null,
      sentByEmail: input.sentByEmail ?? null,
      sentFrom: input.sentFrom ?? null,
      sentFromEmail: input.sentFromEmail ?? null,
      recipients: [],
      sendMeACopy: false,
      eventType: input.eventType,
      deliveryStatus: null,
      providerMessageId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    })
    .returning()
  if (!created) throw new Error('system estimate event did not return a row')
  return created
}

export interface RecordEstimateDeliveryInput {
  messageId: number
  deliveryStatus: EstimateDeliveryStatus
  providerMessageId: string | null
  updatedAt: string
}

export const recordEstimateMessageDelivery = async (
  database: EstimateDatabase,
  input: RecordEstimateDeliveryInput,
): Promise<EstimateMessage> => {
  assertPositiveSafeInteger(input.messageId, 'messageId')
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt')
  if (!deliveryStatuses.has(input.deliveryStatus)) {
    throw new TypeError('estimate delivery status is invalid')
  }
  const [updated] = await database
    .update(estimateMessages)
    .set({
      deliveryStatus: input.deliveryStatus,
      providerMessageId: input.providerMessageId,
      updatedAt: input.updatedAt,
    })
    .where(
      and(
        eq(estimateMessages.id, input.messageId),
        eq(estimateMessages.eventType, 'send'),
        sql`${estimateMessages.deliveryStatus} is not null`,
      ),
    )
    .returning()
  if (!updated) throw new Error('estimate send message does not exist')
  return updated
}
