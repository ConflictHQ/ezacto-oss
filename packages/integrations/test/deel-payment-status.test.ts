import { describe, expect, it, vi } from 'vitest'
import { DeelApiError, type DeelTimesheetStatusReceipt } from '../src/deel/client.js'
import { createDeelPaymentStatusRuntime, type DeelPaymentStatusStore } from '../src/deel/payment-status.js'

const now = '2026-10-26T18:00:00.000Z'
const authority = { userId: 1, sessionId: 7 }
const claim = { timesheetId: 'timesheet-1', contractIds: ['contract-1'], spentDate: '2026-09-15', seconds: 7200, leaseId: 'lease-1' }
const receipt: DeelTimesheetStatusReceipt = {
  timesheetId: 'timesheet-1', contractId: 'contract-1', spentDate: '2026-09-15', quantity: 2,
  status: 'paid', providerStatus: 'paid', totalAmount: '100.00', currency: 'USD',
}
const fixture = (token: string | undefined = 'test-token') => {
  const store = {
    claim: vi.fn<DeelPaymentStatusStore['claim']>().mockResolvedValue([claim]),
    complete: vi.fn<DeelPaymentStatusStore['complete']>().mockResolvedValue(undefined),
    remaining: vi.fn<DeelPaymentStatusStore['remaining']>().mockResolvedValue(0),
  }
  const client = { getTimesheet: vi.fn(async () => receipt) }
  const fetch = vi.fn(async () => { throw new Error('unexpected network call') })
  const runtime = createDeelPaymentStatusRuntime({ token, store, client, fetch, now: () => new Date(now) })
  return { store, client, fetch, runtime }
}

describe('Deel payment status runtime', () => {
  it('records paid only for a receipt matching the saved timesheet, contract, date and hours', async () => {
    const { store, client, runtime } = fixture()
    await expect(runtime.refresh('2026-09', authority)).resolves.toEqual({ configured: true, checked: 1, failed: 0, remaining: 0 })
    expect(store.claim).toHaveBeenCalledWith('2026-09', now, authority)
    expect(client.getTimesheet).toHaveBeenCalledExactlyOnceWith('timesheet-1')
    expect(store.complete).toHaveBeenCalledExactlyOnceWith(claim, { status: 'paid' }, now, authority)
  })

  it.each([
    [{ spentDate: '2026-09-16' }, 'source_mismatch'],
    [{ quantity: 3 }, 'source_mismatch'],
    [{ quantity: null }, 'source_mismatch'],
    [{ contractId: 'another-contract' }, 'contract_mismatch'],
    [{ timesheetId: 'another-timesheet' }, 'contract_mismatch'],
    [{ status: 'unknown', providerStatus: 'new_provider_status' }, 'unknown_status'],
  ] as const)('refuses to project payment for a mismatched or unknown receipt %j', async (fields, error) => {
    const { store, client, runtime } = fixture()
    client.getTimesheet.mockResolvedValue({ ...receipt, ...fields })
    await expect(runtime.refresh('2026-09', authority)).resolves.toMatchObject({ checked: 0, failed: 1 })
    expect(store.complete).toHaveBeenCalledExactlyOnceWith(claim, { error }, now, authority)
  })

  it.each([[401, 'permission_denied'], [403, 'permission_denied'], [404, 'timesheet_missing'], [429, 'rate_limited'], [500, 'provider_unavailable']] as const)('classifies provider HTTP %i without converting failure into payment', async (status, error) => {
    const { store, client, runtime } = fixture()
    client.getTimesheet.mockRejectedValue(new DeelApiError(status))
    await expect(runtime.refresh('2026-09', authority)).resolves.toMatchObject({ checked: 0, failed: 1 })
    expect(store.complete).toHaveBeenCalledExactlyOnceWith(claim, { error }, now, authority)
  })

  it('reports unconfigured without claiming or requesting anything when the token is absent', async () => {
    const { store, client, fetch, runtime } = fixture('')
    await expect(runtime.refresh('2026-09', authority)).resolves.toEqual({ configured: false, checked: 0, failed: 0, remaining: 0 })
    expect(store.claim).not.toHaveBeenCalled()
    expect(store.complete).not.toHaveBeenCalled()
    expect(client.getTimesheet).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
