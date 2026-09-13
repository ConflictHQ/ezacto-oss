/**
 * What Wise pushes at us, and why any of it is believed (issue 543).
 *
 * Wise has no session with us: a delivery arrives from an address we did not
 * authenticate, carrying a claim about money. The signature is therefore the
 * whole of the authorisation, and it is checked before the body is treated as
 * anything but bytes -- parsing first would mean acting on the shape of a
 * payload that nobody proved Wise sent.
 *
 * The signature covers the RAW body. Not a re-serialisation of the parsed
 * object, which would differ from what was signed by a space or a key order and
 * fail for reasons that look nothing like tampering.
 */

/**
 * Wise's sandbox key, published with their own verification example.
 *
 * Embedded because it is a public key for a test environment, it never rotates
 * quietly, and the fixture that proves this code works is signed with it.
 * The live key is configured instead -- see `WiseWebhookVerifier` -- because
 * Wise does rotate that one, and a hard-coded key that has gone stale is a
 * webhook that stops believing real events with no deploy to explain it.
 */
export const WISE_SANDBOX_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU
ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j
wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg
nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg
z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs
VwIDAQAB
-----END PUBLIC KEY-----`

/** The header Wise signs with. */
export const WISE_SIGNATURE_HEADER = 'x-signature-sha256'
/** Wise's own id for the delivery, which is how a retry is recognised. */
export const WISE_DELIVERY_HEADER = 'x-delivery-id'
/** Set on the ping Wise sends when a subscription is created or tested. */
export const WISE_TEST_HEADER = 'x-test-notification'

const PEM_BODY = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/u

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * A PEM public key as the DER bytes `importKey` wants.
 *
 * Whitespace inside the base64 is stripped rather than tolerated: a PEM pasted
 * into an environment variable arrives with whatever line endings the shell
 * gave it, and a key that fails to import because of a carriage return reads as
 * a signature that did not verify.
 */
export const publicKeyDer = (pem: string): Uint8Array => {
  const matched = PEM_BODY.exec(pem.trim())
  if (matched === null) throw new Error('not a PEM public key')
  return decodeBase64(matched[1]!.replace(/\s+/gu, ''))
}

/**
 * Whether Wise signed this exact body.
 *
 * RSASSA-PKCS1-v1_5 over SHA-256, which is what Wise's own example spells as
 * `RSA-SHA256` with `RSA_PKCS1_PADDING`. WebCrypto rather than node:crypto
 * because this runs on Workers.
 */
export const verifyWiseSignature = async (input: {
  readonly body: string
  readonly signature: string | null
  readonly publicKeyPem: string
}): Promise<boolean> => {
  if (input.signature === null || input.signature.trim() === '') return false
  let key: CryptoKey
  let signature: Uint8Array
  try {
    key = await crypto.subtle.importKey(
      'spki',
      publicKeyDer(input.publicKeyPem) as unknown as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    signature = decodeBase64(input.signature.trim())
  } catch {
    // A malformed key or a signature that is not base64 is a refusal, not a
    // crash: an unparseable header is exactly what a forged request looks like.
    return false
  }
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as unknown as ArrayBuffer,
    new TextEncoder().encode(input.body) as unknown as ArrayBuffer,
  )
}

/**
 * Where a transfer can get to.
 *
 * Wise's own list. Kept complete rather than trimmed to the ones acted on,
 * because an unrecognised state is then a Wise change rather than a gap here,
 * and the two want different responses.
 */
export const WISE_TRANSFER_STATES = [
  'incoming_payment_waiting',
  'incoming_payment_initiated',
  'processing',
  'funds_converted',
  'outgoing_payment_sent',
  'charged_back',
  'cancelled',
  'funds_refunded',
  'bounced_back',
  'unknown',
] as const

export type WiseTransferState = (typeof WISE_TRANSFER_STATES)[number]

export interface WiseTransferStateChange {
  readonly kind: 'transfer_state'
  readonly subscriptionId: string
  /** Wise's transfer id, as a string for the reason profile ids are. */
  readonly transferId: string
  readonly profileId: string | null
  readonly currentState: WiseTransferState
  readonly previousState: WiseTransferState | null
  readonly occurredAt: string
}

/**
 * A delivery whose type we do not act on.
 *
 * Kept as a value rather than thrown away, because the ledger records what
 * arrived and "we were told and chose not to act" is a different fact from
 * "nothing arrived".
 */
export interface WiseUnhandledEvent {
  readonly kind: 'unhandled'
  readonly subscriptionId: string
  readonly eventType: string
  readonly occurredAt: string | null
}

export type WiseEvent = WiseTransferStateChange | WiseUnhandledEvent

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : typeof value === 'number'
      ? String(value)
      : null

const state = (value: unknown): WiseTransferState | null => {
  const found = WISE_TRANSFER_STATES.find((known) => known === value)
  return found ?? null
}

/**
 * Reads a delivery, keeping every id as text.
 *
 * `JSON.parse` rounds an integer past 2^53 before anything downstream can see
 * the original digits, and a rounded transfer id names somebody else's payment.
 * Wise's ids are inside the safe range today; the quoting costs nothing and
 * stops that from being a thing anyone has to remember.
 */
export const parseWiseEvent = (body: string): WiseEvent | null => {
  let payload: Record<string, unknown>
  try {
    payload = asObject(JSON.parse(body.replace(/"(id|profile_id|account_id)"\s*:\s*(-?\d+)/gu, '"$1":"$2"')))
  } catch {
    return null
  }
  const eventType = text(payload.event_type)
  const subscriptionId = text(payload.subscription_id) ?? ''
  if (eventType === null) return null

  if (eventType === 'transfers#state-change') {
    const data = asObject(payload.data)
    const resource = asObject(data.resource)
    const transferId = text(resource.id)
    const currentState = state(data.current_state)
    // A state change that names no transfer, or a state Wise has added since,
    // is recorded as unhandled rather than guessed at. Guessing here moves the
    // state of a payment.
    if (transferId === null || currentState === null) {
      return {
        kind: 'unhandled',
        subscriptionId,
        eventType,
        occurredAt: text(data.occurred_at),
      }
    }
    return {
      kind: 'transfer_state',
      subscriptionId,
      transferId,
      profileId: text(resource.profile_id),
      currentState,
      previousState: state(data.previous_state),
      occurredAt: text(data.occurred_at) ?? text(payload.sent_at) ?? '',
    }
  }

  return {
    kind: 'unhandled',
    subscriptionId,
    eventType,
    occurredAt: text(asObject(payload.data).occurred_at) ?? text(payload.sent_at),
  }
}

/**
 * What a transfer state means for a payout we recorded.
 *
 * `null` is "nothing to do yet" -- a transfer in flight. The two that are not
 * null are the only ones that settle it, and both are final at Wise, which is
 * what makes them safe to write against a log whose sent rows are immutable.
 */
export const payoutOutcomeFor = (
  transferState: WiseTransferState,
): 'sent' | 'failed' | null => {
  if (transferState === 'outgoing_payment_sent') return 'sent'
  if (
    transferState === 'cancelled' ||
    transferState === 'funds_refunded' ||
    transferState === 'charged_back' ||
    transferState === 'bounced_back'
  ) {
    return 'failed'
  }
  return null
}
