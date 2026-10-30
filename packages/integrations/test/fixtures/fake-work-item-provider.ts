import type {
  PostedWorkItemTimeNote,
  WorkItemProvider,
  WorkItemSnapshot,
  WorkItemTimeNote,
  WorkItemWebhookRequest,
  WorkItemWebhookVerdict,
} from '../../src/work-items/provider.js'

/**
 * An in-memory tracker. It honours the one rule every real provider must: a
 * time note with a key it has seen is not written again. Signatures are the
 * shared secret itself, which is enough to exercise accept and refuse.
 */
export class FakeWorkItemProvider implements WorkItemProvider {
  readonly id = 'fake'
  readonly items = new Map<string, WorkItemSnapshot>()
  readonly notes = new Map<string, WorkItemTimeNote & { remoteId: string }>()

  constructor(readonly secret = 'fake-secret') {}

  async verifyWebhook(request: WorkItemWebhookRequest): Promise<WorkItemWebhookVerdict> {
    const signature = request.headers['x-fake-signature']
    const delivery = request.headers['x-fake-delivery']
    if (signature === undefined) return { verified: false, reason: 'missing_signature' }
    if (signature !== this.secret) return { verified: false, reason: 'bad_signature' }
    if (delivery === undefined) return { verified: false, reason: 'malformed' }
    return { verified: true, deliveryId: delivery }
  }

  async fetchItem(itemId: string): Promise<WorkItemSnapshot | null> {
    return this.items.get(itemId) ?? null
  }

  async postTimeNote(note: WorkItemTimeNote): Promise<PostedWorkItemTimeNote> {
    const existing = this.notes.get(note.idempotencyKey)
    if (existing !== undefined) return { remoteId: existing.remoteId, created: false }
    const remoteId = `note-${this.notes.size + 1}`
    this.notes.set(note.idempotencyKey, { ...note, remoteId })
    return { remoteId, created: true }
  }
}
