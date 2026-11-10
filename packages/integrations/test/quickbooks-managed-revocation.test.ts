import { describe, expect, it, vi } from 'vitest'
import type { ManagedQuickBooksLifecycleStore, ManagedQuickBooksRevocationReceipt } from '@ezacto/core'
import { createManagedQuickBooksRevocationCoordinator } from '../src/quickbooks/managed-revocation.js'

const receipt = (status: ManagedQuickBooksRevocationReceipt['status']): ManagedQuickBooksRevocationReceipt => ({
  revocationId: 'a'.repeat(64), grantId: 'b'.repeat(64), actorUserId: 1, realmId: 'owned', environment: 'sandbox',
  reason: 'disconnect', fencedGeneration: 1, status, attempts: 1, complete: status === 'revoked',
})
const custody = { revocationId: 'a'.repeat(64), realmId: 'owned', environment: 'sandbox' as const, refreshToken: 'PRIVATE_TOKEN' }

describe('managed QuickBooks revocation coordination', () => {
  it('commits an attempt before transport and persists the observed result', async () => {
    const order: string[] = []
    const store: Pick<ManagedQuickBooksLifecycleStore, 'beginRevocation' | 'settleRevocation'> = {
      beginRevocation: async () => { order.push('claim'); return { revocation: receipt('attempting'), custody } },
      settleRevocation: async (_id, outcome) => { order.push(outcome); return receipt('revoked') },
    }
    const coordinator = createManagedQuickBooksRevocationCoordinator({ store, admitted: () => true,
      revoke: async () => { order.push('provider'); return 'revoked' }, now: () => new Date('2026-01-01T00:00:00Z') })
    expect(await coordinator.run(custody.revocationId)).toBe('revoked')
    expect(order).toEqual(['claim', 'provider', 'revoked'])
  })
  it('does not retry or settle an ambiguous provider response', async () => {
    const settle = vi.fn(), revoke = vi.fn(async () => { throw new Error('private provider response') })
    const begin = vi.fn().mockResolvedValueOnce({ revocation: receipt('attempting'), custody })
      .mockResolvedValueOnce({ revocation: receipt('attempting'), custody: null })
    const coordinator = createManagedQuickBooksRevocationCoordinator({ store: { beginRevocation: begin, settleRevocation: settle },
      admitted: () => true, revoke, now: () => new Date('2026-01-01T00:00:00Z') })
    expect(await coordinator.run(custody.revocationId)).toBe('uncertain')
    expect(await coordinator.run(custody.revocationId)).toBe('uncertain')
    expect(revoke).toHaveBeenCalledOnce()
    expect(settle).not.toHaveBeenCalled()
  })
  it('releases a proven-unsent claim if admission is lost', async () => {
    const admitted = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const settle = vi.fn(async () => receipt('pending')), revoke = vi.fn()
    const coordinator = createManagedQuickBooksRevocationCoordinator({ store: {
      beginRevocation: async () => ({ revocation: receipt('attempting'), custody }), settleRevocation: settle,
    }, admitted, revoke, now: () => new Date('2026-01-01T00:00:00Z') })
    expect(await coordinator.run(custody.revocationId)).toBe('pending')
    expect(revoke).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledWith(custody.revocationId, 'not_revoked', expect.any(String))
  })
})
