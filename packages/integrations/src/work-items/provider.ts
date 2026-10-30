/**
 * The seam between eZacto and an issue tracker (issue 1008, slice 1).
 *
 * One interface and no implementation: each provider is its own slice, and a
 * provider that cannot honour a method says so in its own documentation rather
 * than faking it here. The contract is written from what every tracker in the
 * plan can do, which is less than any one of them can:
 *
 * - Time flows out and an item's title and state flow in. There is no field a
 *   provider and eZacto both write, so there is nothing to reconcile.
 * - A tracker without a native worklog (GitHub, Linear) takes a *comment* that
 *   carries the time. `idempotencyKey` is mandatory so a retry finds the
 *   comment it already made instead of adding a second.
 * - A provider holds its credential from construction. No method takes one, so
 *   no call site can log or forward one by accident.
 */

export interface WorkItemSnapshot {
  /** The provider's own identity, as stored on a link. */
  readonly itemId: string
  readonly url: string
  readonly title: string
  readonly state: 'open' | 'closed'
}

/** A delivery as received. The body is the raw text: a signature covers bytes, not a parsed object. */
export interface WorkItemWebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
}

export type WorkItemWebhookVerdict =
  /** `deliveryId` is the provider's id for this delivery, for replay protection. */
  | { readonly verified: true; readonly deliveryId: string }
  | { readonly verified: false; readonly reason: 'missing_signature' | 'bad_signature' | 'malformed' }

export interface WorkItemTimeNote {
  readonly itemId: string
  /** Names one entry-day. The same key always resolves to the same remote note. */
  readonly idempotencyKey: string
  readonly spentDate: string
  readonly seconds: number
}

export interface PostedWorkItemTimeNote {
  /** The provider's id for the comment or worklog, to update or remove it later. */
  readonly remoteId: string
  /** False when the key had already been posted and nothing new was written. */
  readonly created: boolean
}

export interface WorkItemProvider {
  readonly id: string
  verifyWebhook(request: WorkItemWebhookRequest): Promise<WorkItemWebhookVerdict>
  /** Null when the item no longer exists or is not visible to the connection. */
  fetchItem(itemId: string): Promise<WorkItemSnapshot | null>
  postTimeNote(note: WorkItemTimeNote): Promise<PostedWorkItemTimeNote>
}
