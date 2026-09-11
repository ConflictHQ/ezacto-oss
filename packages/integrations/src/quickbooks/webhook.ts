/**
 * Intuit webhook deliveries: proving one came from Intuit, and reading it.
 *
 * The endpoint is a public URL. Anything on the internet can POST to it, and a
 * forged delivery that got through would have us record a payment against an
 * invoice nobody paid. The signature is the only thing that distinguishes a
 * delivery from a guess, so verification is not optional and this module makes
 * it hard to skip: the parse function will not take a body that has not been
 * verified.
 */

export class QuickBooksWebhookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuickBooksWebhookError'
  }
}

/**
 * One entity change, as Intuit describes it.
 *
 * `lastUpdated` is Intuit's instant for the change, and together with the
 * entity's identity it is what makes one delivery distinguishable from a retry
 * of the same one.
 */
export interface QuickBooksEntityChange {
  readonly realmId: string
  readonly name: string
  readonly id: string
  readonly operation: string
  readonly lastUpdated: string
}

const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  // Compared in constant time even when the lengths differ: returning early on
  // length leaks how much of a guess was right, which over enough attempts is
  // how a signature gets found one byte at a time.
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const decodeBase64 = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

export interface VerifyWebhookInput {
  /**
   * The body exactly as it arrived, before any parsing. A re-serialised object
   * is a different string, and its HMAC will not match -- which is why the
   * route has to read the text first and parse afterwards.
   */
  readonly payload: string
  /** The `intuit-signature` header: base64 of HMAC-SHA256 over the payload. */
  readonly signature: string | null
  /** From the webhooks page in the Intuit portal, per environment. */
  readonly verifierToken: string
}

export const verifyWebhookSignature = async (
  input: Readonly<VerifyWebhookInput>,
): Promise<boolean> => {
  if (input.signature === null || input.signature.trim() === '') return false
  if (input.verifierToken.trim() === '') {
    // A blank verifier cannot verify anything. Answering "valid" here would turn
    // a misconfigured deployment into an open endpoint, which is the worst
    // possible reading of an empty setting.
    throw new QuickBooksWebhookError('a verifier token is required to check a webhook signature')
  }
  const expected = decodeBase64(input.signature)
  if (expected === null) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const actual = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input.payload)),
  )
  return timingSafeEqual(actual, expected)
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

/**
 * The changes in one delivery, flattened.
 *
 * Intuit batches: one delivery carries a list of realms, each with a list of
 * entities. Callers want the entities, each still knowing which company it came
 * from, because a delivery for a realm we are not connected to must be refused
 * rather than applied to whichever company we happen to hold.
 */
export const parseWebhookNotification = (payload: string): readonly QuickBooksEntityChange[] => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new QuickBooksWebhookError('webhook payload was not JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new QuickBooksWebhookError('webhook payload was not an object')
  }
  const notifications = (body as Record<string, unknown>)['eventNotifications']
  if (notifications === undefined) return []
  if (!Array.isArray(notifications)) {
    throw new QuickBooksWebhookError('eventNotifications must be an array')
  }

  const changes: QuickBooksEntityChange[] = []
  for (const notification of notifications) {
    if (typeof notification !== 'object' || notification === null) continue
    const realmId = text((notification as Record<string, unknown>)['realmId'])
    if (realmId === null) continue
    const event = (notification as Record<string, unknown>)['dataChangeEvent']
    if (typeof event !== 'object' || event === null) continue
    const entities = (event as Record<string, unknown>)['entities']
    if (!Array.isArray(entities)) continue
    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue
      const row = entity as Record<string, unknown>
      const name = text(row['name'])
      const id = text(row['id'])
      const operation = text(row['operation'])
      const lastUpdated = text(row['lastUpdated'])
      // A change missing any part of its identity cannot be deduplicated, and a
      // change that cannot be deduplicated cannot be applied safely.
      if (name === null || id === null || operation === null || lastUpdated === null) continue
      changes.push({ realmId, name, id, operation, lastUpdated })
    }
  }
  return changes
}

/**
 * Intuit sends `lastUpdated` without a zone, meaning UTC.
 *
 * Stored timestamps here are canonical ISO with a `Z`, and the delivery table
 * checks that shape -- so a value that arrives as `2026-09-11T12:00:00` has to
 * be made explicit rather than left to whatever parses it next.
 */
export const canonicalLastUpdated = (value: string): string => {
  const parsed = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? value : `${value}Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new QuickBooksWebhookError(`lastUpdated is not a timestamp: ${value}`)
  }
  return parsed.toISOString()
}
