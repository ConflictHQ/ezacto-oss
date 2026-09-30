import { PaymentProviderError, type PaymentProvider, type PaymentTransfer } from '@ezacto/core'
import { createWiseClient, WISE_API_BASE } from './client.js'

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const required = (value: unknown, field: string): string => {
  if (
    (typeof value === 'string' && value.trim()) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  )
    return String(value)
  throw new PaymentProviderError(`Wise response is missing ${field}.`, 502)
}
const cents = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new PaymentProviderError('Wise returned an invalid monetary amount.', 502)
  const result = Math.round(value * 100)
  if (!Number.isSafeInteger(result) || Math.abs(result / 100 - value) > 0.0000001)
    throw new PaymentProviderError('Wise returned an unsupported monetary precision.', 502)
  return result
}
const numericId = (value: string): number => {
  const id = Number(value)
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(id) || id <= 0)
    throw new PaymentProviderError('Wise identifier cannot be represented safely.', 502)
  return id
}
const transferOf = (body: Record<string, unknown>): PaymentTransfer => ({
  id: required(body.id, 'transfer id'),
  status: required(body.status, 'transfer status'),
  customer_transaction_id: required(body.customerTransactionId, 'transaction id'),
  recipient_id: required(body.targetAccount, 'recipient id'),
  target_cents: cents(body.targetValue),
  target_currency: required(body.targetCurrency, 'target currency'),
})

export const createWisePaymentProvider = (options: {
  token: string
  profileId?: string | undefined
  fetch?: typeof fetch
}): PaymentProvider => {
  const call = options.fetch ?? fetch
  const identities = createWiseClient({ token: options.token, fetchImplementation: call })
  const request = async (
    path: string,
    body?: unknown,
    correlationId: string = crypto.randomUUID(),
  ): Promise<Record<string, unknown>> => {
    const response = await call(`${WISE_API_BASE}/2026Q3${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'X-External-Correlation-Id': correlationId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      const seconds =
        retry === null
          ? null
          : /^\d+$/u.test(retry)
            ? Number(retry)
            : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000))
      // Response bodies may contain bank details. Persist only status and trace.
      throw new PaymentProviderError(
        `Wise ${response.status} during ${body === undefined ? 'lookup' : 'payment preparation'}. Trace: ${response.headers.get('x-trace-id') ?? correlationId}`,
        response.status,
        seconds !== null && Number.isFinite(seconds) ? seconds : null,
      )
    }
    const raw = await response.text()
    return object(JSON.parse(raw.replace(/"(id|targetAccount)"\s*:\s*(\d+)/gu, '"$1":"$2"')))
  }
  return {
    quote: async (destination, sourceCurrency, targetCurrency, amountCents) => {
      const profiles = await identities.profiles()
      const businesses = profiles.filter((x) => x.type === 'business')
      const profile = options.profileId
        ? profiles.find((x) => x.id === options.profileId)
        : businesses.length === 1
          ? businesses[0]
          : undefined
      if (!profile)
        throw new PaymentProviderError('Configure the paying Wise profile explicitly.', 422)
      const body = await request(`/profiles/${encodeURIComponent(profile.id)}/quotes`, {
        sourceCurrency,
        targetCurrency,
        targetAmount: amountCents / 100,
        sourceAmount: null,
        preferredPayIn: 'BALANCE',
        ...(destination.kind === 'contact'
          ? { contactId: destination.external_id }
          : { targetAccount: numericId(destination.external_id) }),
      })
      const choices = Array.isArray(body.paymentOptions) ? body.paymentOptions.map(object) : []
      const choice = choices.find((x) => x.payIn === 'BALANCE' && x.disabled === false)
      if (!choice)
        throw new PaymentProviderError(
          'Wise balance funding is unavailable for this currency or account.',
          422,
        )
      const recipientId = required(
        body.targetAccount ?? (destination.kind === 'account' ? destination.external_id : null),
        'resolved recipient',
      )
      const recipient = await request(`/accounts/${encodeURIComponent(recipientId)}`)
      if (recipient.active === false || recipient.ownedByCustomer === true)
        throw new PaymentProviderError('This recipient cannot be used for staff payments.', 422)
      const target = cents(choice.targetAmount ?? body.targetAmount)
      const source = cents(choice.sourceAmount ?? body.sourceAmount)
      if (
        target !== amountCents ||
        body.sourceCurrency !== sourceCurrency ||
        body.targetCurrency !== targetCurrency
      )
        throw new PaymentProviderError(
          'Wise quote does not match the requested amount or currencies.',
          502,
        )
      const expires = required(body.expirationTime, 'quote expiry')
      if (!Number.isFinite(Date.parse(expires)))
        throw new PaymentProviderError('Wise quote expiry is invalid.', 502)
      const rate = body.rate
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0)
        throw new PaymentProviderError('Wise quote rate is invalid.', 502)
      return {
        id: required(body.id, 'quote id'),
        profile_id: profile.id,
        recipient_id: recipientId,
        recipient_name: required(
          recipient.accountHolderName ?? object(recipient.name).fullName,
          'recipient name',
        ),
        source_currency: sourceCurrency,
        target_currency: targetCurrency,
        target_cents: target,
        source_cents: source,
        fee_cents: cents(object(choice.fee).total),
        rate,
        expires_at: expires,
        estimated_arrival:
          typeof choice.estimatedDelivery === 'string' ? choice.estimatedDelivery : null,
      }
    },
    create: async (item, quote) =>
      transferOf(
        await request(
          '/transfers',
          {
            targetAccount: numericId(quote.recipient_id),
            quoteUuid: quote.id,
            customerTransactionId: item.id,
            details: { reference: `Staff payment ${item.month}` },
          },
          item.id,
        ),
      ),
    read: async (id) => transferOf(await request(`/transfers/${encodeURIComponent(id)}`)),
    fund: async (profileId, transferId, correlationId) => {
      const result = await request(
        `/profiles/${encodeURIComponent(profileId)}/transfers/${encodeURIComponent(transferId)}/payments`,
        { type: 'BALANCE' },
        correlationId,
      )
      if (result.status === 'REJECTED') return 'rejected'
      if (result.status !== 'COMPLETED' && result.status !== 'CREATED')
        throw new PaymentProviderError(
          'Wise funding outcome is unknown; reconciliation required.',
          502,
        )
      return 'accepted'
    },
  }
}
