import type { ManagedQuickBooksLifecycleStore, ManagedQuickBooksRevocationCustody } from '@ezacto/core'

/** The host commits lifecycle operations independently and admits transport only
 * under the tenant's current incarnation and provider-effect ownership. */
export const createManagedQuickBooksRevocationCoordinator = (input: {
  readonly store: Pick<ManagedQuickBooksLifecycleStore, 'beginRevocation' | 'settleRevocation'>
  readonly admitted: () => boolean | Promise<boolean>
  readonly revoke: (custody: ManagedQuickBooksRevocationCustody) => Promise<'revoked' | 'not_revoked'>
  readonly now: () => Date
}) => ({
  async run(revocationId: string): Promise<'revoked' | 'pending' | 'uncertain'> {
    if (!await input.admitted()) return 'pending'
    const claimed = await input.store.beginRevocation(revocationId, input.now().toISOString())
    if (claimed.revocation.status === 'revoked') return 'revoked'
    if (claimed.custody === null) return 'uncertain'
    if (!await input.admitted()) {
      await input.store.settleRevocation(revocationId, 'not_revoked', input.now().toISOString())
      return 'pending'
    }
    let outcome: 'revoked' | 'not_revoked'
    try { outcome = await input.revoke(claimed.custody) } catch { return 'uncertain' }
    await input.store.settleRevocation(revocationId, outcome, input.now().toISOString())
    return outcome === 'revoked' ? 'revoked' : 'pending'
  },
})
