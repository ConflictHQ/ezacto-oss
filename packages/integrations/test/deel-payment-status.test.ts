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
    acquireRefresh: vi.fn<DeelPaymentStatusStore['acquireRefresh']>().mockResolvedValue({ leaseId: 'global-lease', retryAfterMs: 0 }),
    touchRefresh: vi.fn<DeelPaymentStatusStore['touchRefresh']>().mockResolvedValue(true),
    releaseRefresh: vi.fn<DeelPaymentStatusStore['releaseRefresh']>().mockResolvedValue(undefined),
    releaseClaims: vi.fn<DeelPaymentStatusStore['releaseClaims']>().mockResolvedValue(undefined),
    claim: vi.fn<DeelPaymentStatusStore['claim']>().mockResolvedValue([claim]),
    complete: vi.fn<DeelPaymentStatusStore['complete']>().mockResolvedValue(undefined),
    remaining: vi.fn<DeelPaymentStatusStore['remaining']>().mockResolvedValue(0),
  }
  const client = { getTimesheet: vi.fn(async () => receipt) }
  const fetch = vi.fn(async () => { throw new Error('unexpected network call') })
  const runtime = createDeelPaymentStatusRuntime({ token, store, client, fetch, now: () => new Date(now), sleep: async () => undefined })
  return { store, client, fetch, runtime }
}

describe('Deel payment status runtime', () => {
  it('records paid only for a receipt matching the saved timesheet, contract, date and hours', async () => {
    const { store, client, runtime } = fixture()
    await expect(runtime.refresh('2026-09', authority)).resolves.toEqual({ configured: true, checked: 1, failed: 0, remaining: 0, retry_after_ms: 500 })
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
    await expect(runtime.refresh('2026-09', authority)).resolves.toEqual({ configured: false, checked: 0, failed: 0, remaining: 0, retry_after_ms: 0 })
    expect(store.claim).not.toHaveBeenCalled()
    expect(store.complete).not.toHaveBeenCalled()
    expect(client.getTimesheet).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('organization-wide status throttling', () => {
  it('does not scan or read while another refresher owns the lease or cooldown', async () => {
    const { store, client, runtime } = fixture()
    store.acquireRefresh.mockResolvedValue({ leaseId: null, retryAfterMs: 45000 })
    await expect(runtime.refresh('2026-09', authority)).resolves.toEqual({ configured: true, checked: 0, failed: 0, remaining: 0, retry_after_ms: 45000 })
    expect(store.claim).not.toHaveBeenCalled()
    expect(client.getTimesheet).not.toHaveBeenCalled()
  })

  it.each([[null, 60000], ['120', 120000], ['1.2345', 1235], ['Mon, 26 Oct 2026 18:00:15 GMT', 15000], ['nonsense', 60000], ['3600', 3600000], ['10000', 10000000]] as const)('stops on429, honors bounded Retry-After %s and releases unsent claims', async (header, expected) => {
    const { store, client, runtime } = fixture()
    const later = { ...claim, timesheetId: 'later', leaseId: 'later-lease' }
    store.claim.mockResolvedValue([claim, later])
    client.getTimesheet.mockRejectedValue(new DeelApiError(429, header))
    await expect(runtime.refresh('2026-09', authority)).resolves.toMatchObject({ checked: 0, failed: 1, remaining: 1, retry_after_ms: expected })
    expect(client.getTimesheet).toHaveBeenCalledTimes(1)
    expect(store.releaseClaims).toHaveBeenCalledWith([later])
    expect(store.releaseRefresh).toHaveBeenCalledWith('global-lease', expected, now)
  })

  it('paces sequential reads and stops a refresher whose global lease was lost', async () => {
    const { store, client } = fixture()
    store.claim.mockResolvedValue([claim, claim, claim])
    const events: string[] = []
    client.getTimesheet.mockImplementation(async () => { events.push('read'); return receipt })
    const runtime = createDeelPaymentStatusRuntime({ token: 'test-token', store, client, fetch: async () => { throw new Error('unexpected') }, now: () => new Date(now), sleep: async (ms) => { events.push(`wait:${ms}`) } })
    await runtime.refresh('2026-09', authority)
    expect(events).toEqual(['read', 'wait:500', 'read', 'wait:500', 'read'])
    events.length = 0
    store.touchRefresh.mockResolvedValue(false)
    await runtime.refresh('2026-09', authority)
    expect(events).toEqual([])
    expect(store.releaseClaims).toHaveBeenLastCalledWith([claim, claim, claim])
  })
})


it('persists a rate-limit cooldown even when releasing unattempted claims fails', async () => {
  const { store, client, runtime } = fixture()
  store.claim.mockResolvedValue([claim, { ...claim, timesheetId: 'later' }])
  client.getTimesheet.mockRejectedValue(new DeelApiError(429, '3600'))
  store.releaseClaims.mockRejectedValue(new Error('database failed'))
  await expect(runtime.refresh('2026-09', authority)).rejects.toThrow('database failed')
  expect(store.releaseRefresh).toHaveBeenCalledWith('global-lease', 3600000, now)
  expect(store.releaseRefresh.mock.invocationCallOrder[0]).toBeLessThan(store.releaseClaims.mock.invocationCallOrder[0]!)
})
