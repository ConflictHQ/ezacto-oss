import { createQuickBooksMirrorSubscriber, quickBooksMirrorEventNeedsProvider, ManagedQuickBooksWriteUnavailableError, type QuickBooksRuntime } from '@ezacto/integrations'
import type { OutboxSubscriber, OutboxEventRecord, ManagedQuickBooksOutboxAdmission } from '@ezacto/db/d1'

/** Keep the required subscriber enrolled during temporary host unavailability.
 * No provider probe or runtime composition occurs in the preclaim check.
 */
export const createManagedQuickBooksOutboxSubscriber = (input: {
  readonly runtime: QuickBooksRuntime | null
  readonly available: () => boolean
  readonly readAdmission: (eventId: string) => Promise<ManagedQuickBooksOutboxAdmission>
}): OutboxSubscriber => {
  const delegate = input.runtime === null ? null : createQuickBooksMirrorSubscriber(input.runtime)
  const admission = async (event: Readonly<OutboxEventRecord>): Promise<'skip' | 'pause' | 'deliver'> => {
    if (!quickBooksMirrorEventNeedsProvider(event)) return 'skip'
    const grant = await input.readAdmission(event.id)
    if (grant.kind === 'absent' || grant.kind === 'stale') return 'skip'
    if (grant.kind !== 'current') return 'pause'
    if (input.runtime === null || !input.available()) return 'pause'
    const service = input.runtime.service
    if (service.authorizationStatus !== undefined && await service.authorizationStatus() !== 'ready') return 'pause'
    // Pending writes can recover with the original request ID. Only custody
    // requiring review blocks new claims; do not deadlock safe recovery.
    if (service.writeStatus !== undefined && await service.writeStatus() === 'unavailable') return 'pause'
    return 'deliver'
  }
  return {
    id: 'quickbooks_mirror',
    available: async event => await admission(event) !== 'pause',
    deliver: async event => {
      const state = await admission(event)
      if (state === 'skip') return
      if (state !== 'deliver' || delegate === null) throw new ManagedQuickBooksWriteUnavailableError()
      await delegate.deliver(event)
    },
  }
}
