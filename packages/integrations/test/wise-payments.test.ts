import { describe, it, expect, vi } from 'vitest'
import { createWisePaymentProvider } from '../src/wise/payments.js'
import type { PaymentItem } from '@ezacto/core'
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })
const quote = {
  id: 'quote',
  sourceCurrency: 'USD',
  targetCurrency: 'USD',
  targetAccount: 456,
  rate: 1,
  expirationTime: '2026-10-01T12:00:00Z',
  paymentOptions: [
    {
      payIn: 'BALANCE',
      disabled: false,
      sourceAmount: 50.5,
      targetAmount: 50,
      fee: { total: 0.5 },
      estimatedDelivery: '2026-10-02T12:00:00Z',
    },
  ],
}
describe('Wise payment provider', () => {
  it('resolves contacts through quotes, verifies the recipient name and excludes bank details', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(response([{ id: 123, type: 'BUSINESS' }]))
      .mockResolvedValueOnce(response(quote))
      .mockResolvedValueOnce(
        response({
          id: 456,
          accountHolderName: 'Person Two',
          details: { accountNumber: 'private-bank-number' },
        }),
      )
    const provider = createWisePaymentProvider({ token: 'fixture-token', fetch: call })
    const result = await provider.quote(
      { id: 1, kind: 'contact', external_id: 'contact-uuid' },
      'USD',
      'USD',
      5000,
    )
    expect(result).toMatchObject({
      recipient_id: '456',
      recipient_name: 'Person Two',
      target_cents: 5000,
      source_cents: 5050,
      fee_cents: 50,
    })
    expect(JSON.parse(call.mock.calls[1]![1].body)).toMatchObject({
      contactId: 'contact-uuid',
      targetAmount: 50,
      preferredPayIn: 'BALANCE',
    })
    expect(JSON.stringify(result)).not.toContain('private-bank-number')
  })
  it('refuses ambiguous business profiles before quoting', async () => {
    const call = vi.fn().mockResolvedValue(
      response([
        { id: 1, type: 'BUSINESS' },
        { id: 2, type: 'BUSINESS' },
      ]),
    )
    await expect(
      createWisePaymentProvider({ token: 'test', fetch: call }).quote(
        { id: 1, kind: 'account', external_id: '456' },
        'USD',
        'USD',
        5000,
      ),
    ).rejects.toThrow(/profile explicitly/)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('preserves the transaction identity across transfer retries', async () => {
    const call = vi
      .fn()
      .mockImplementation(async () =>
        response({
          id: 999,
          status: 'incoming_payment_waiting',
          customerTransactionId: 'tx',
          targetAccount: 456,
          targetValue: 50,
          targetCurrency: 'USD',
        }),
      )
    const provider = createWisePaymentProvider({ token: 'test', fetch: call })
    const item = { id: 'tx', month: '2026-09' } as PaymentItem
    const q = { recipient_id: '456', id: 'persisted-quote' } as PaymentItem['quote']
    await provider.create(item, q)
    await provider.create(item, q)
    expect(call.mock.calls[0]![1].body).toBe(call.mock.calls[1]![1].body)
    expect(JSON.parse(call.mock.calls[0]![1].body)).toMatchObject({
      quoteUuid: 'persisted-quote',
      customerTransactionId: 'tx',
    })
  })
  it('distinguishes a rejected funding business response from a successful HTTP status', async () => {
    const call = vi.fn().mockResolvedValue(response({ status: 'REJECTED' }))
    expect(
      await createWisePaymentProvider({ token: 'test', fetch: call }).fund('123', '999', 'tx'),
    ).toBe('rejected')
  })
  it('propagates Retry-After and a safe trace without logging provider response data', async () => {
    const call = vi
      .fn()
      .mockResolvedValue(
        response({ secret: 'bank-info' }, 429, { 'retry-after': '180', 'x-trace-id': 'trace-1' }),
      )
    const provider = createWisePaymentProvider({ token: 'test', fetch: call })
    await expect(provider.read('999')).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 180,
      message: expect.stringContaining('trace-1'),
    })
  })
})
