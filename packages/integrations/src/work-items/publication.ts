/**
 * Opt-in time publication as an app-owned issue comment (issue 1176, contract).
 *
 * Contract only: no network, no storage. A real adapter implements
 * `CommentSurface` (GitHub issue comments) and a real store implements
 * `PublicationJournal` (SQLite and D1 with the same uniqueness and fences);
 * both must pass `publication.test.ts` through the fakes' behaviour.
 *
 * Invariants:
 * - A POST is never assumed idempotent. Before any create is sent the attempt is
 *   journaled; after an ambiguous failure the next run reconciles by listing and
 *   matching a comment on BOTH the app author and the connection-bound marker.
 * - Absence is provable only from a complete listing taken after `settleMs` has
 *   passed since the attempt. Otherwise the publication is held for an operator.
 * - Edit and delete touch only a comment that is verified app-owned and whose body
 *   still equals what we last wrote. Anything else is a visible conflict; nothing
 *   is silently recreated, overwritten or removed.
 * - The body carries the day and seconds only: no rate, invoice, payment or note.
 * - Nothing here reads or writes local time.
 */

export interface RemoteComment {
  readonly id: string
  readonly authorId: string
  readonly body: string
}

export interface CommentListing {
  readonly comments: readonly RemoteComment[]
  /** False when the listing was cut off; absence cannot then be proved. */
  readonly complete: boolean
}

/** Thrown by a surface when a write may or may not have landed (timeout, 5xx after send). */
export class AmbiguousWriteError extends Error {
  constructor() {
    super('ambiguous_write')
  }
}

/** Thrown by a surface when the provider asked us to wait. */
export class CooldownError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('cooldown')
  }
}

export interface CommentSurface {
  /** The authorized app's own identity on the provider. */
  readonly appAuthorId: string
  listComments(itemId: string): Promise<CommentListing>
  /** Null when the comment no longer exists. */
  getComment(itemId: string, commentId: string): Promise<RemoteComment | null>
  createComment(itemId: string, body: string): Promise<RemoteComment>
  updateComment(itemId: string, commentId: string, body: string): Promise<RemoteComment>
  deleteComment(itemId: string, commentId: string): Promise<void>
}

export interface PublishedValues {
  readonly spentDate: string
  readonly seconds: number
}

export type PublicationStatus =
  | 'pending'
  | 'attempted' // a create was sent and its result is unknown (attemptedAt stays set until reconciled)
  | 'published'
  | 'ambiguous' // absence could not be proved; operator action
  | 'conflicted' // a human changed or removed our comment; operator action
  | 'deferred' // provider cooldown
  | 'retired'

/** One row per (connectionId, entryId, itemId). SQLite and D1 enforce that uniqueness. */
export interface PublicationRecord {
  readonly connectionId: string
  readonly entryId: string
  readonly itemId: string
  readonly status: PublicationStatus
  readonly sourceVersion: number
  readonly remoteId: string | null
  readonly lastBody: string | null
  readonly lastPublished: PublishedValues | null
  readonly attemptedAt: number | null
  readonly retryAt: number | null
  /** Monotonic claim fence; a write with a stale fence is refused by the store. */
  readonly fence: number
}

export interface PublicationKey {
  readonly connectionId: string
  readonly entryId: string
  readonly itemId: string
}

export interface PublicationJournal {
  /**
   * Take the exclusive claim on a key, creating the row when absent, and return it
   * with a new fence. Null when another worker holds the claim, or when the
   * connection was disconnected or revoked (the store checks in the same statement).
   */
  claim(key: PublicationKey, sourceVersion: number): Promise<PublicationRecord | null>
  /** Persist under the fence; false and no change when the fence is stale. */
  save(record: PublicationRecord): Promise<boolean>
  release(key: PublicationKey, fence: number): Promise<void>
}

export type PublishOutcome =
  | 'created'
  | 'adopted' // found our earlier comment after an ambiguous attempt
  | 'updated'
  | 'unchanged'
  | 'deleted'
  | 'busy'
  | 'fenced'
  | 'deferred'
  | 'ambiguous'
  | 'conflicted'

/** Operator-facing, safe: a code and ids, never a provider payload. */
export interface PublicationResult {
  readonly outcome: PublishOutcome
  readonly code: string | null
}

export interface PublishContext {
  readonly surface: CommentSurface
  readonly journal: PublicationJournal
  /** Unguessable and bound to one connection; never logged. */
  readonly marker: string
  readonly now: () => number
  /** Minimum time after an attempt before a missing comment counts as absent. */
  readonly settleMs: number
}

const markerLine = (marker: string, entryId: string): string =>
  `<!-- ezacto-time:${marker}:${entryId} -->`

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', s > 0 || seconds === 0 ? `${s}s` : '']
    .filter(Boolean)
    .join(' ')
}

/** The exact text that will be published. Preview shows this, byte for byte. */
export function renderTimeComment(
  marker: string,
  entryId: string,
  values: PublishedValues,
): string {
  return `${markerLine(marker, entryId)}\nTime logged: ${formatDuration(values.seconds)} on ${values.spentDate}`
}

const isOurs = (c: RemoteComment, ctx: PublishContext, entryId: string): boolean =>
  c.authorId === ctx.surface.appAuthorId && c.body.startsWith(markerLine(ctx.marker, entryId))

/** A comment we may edit or remove: ours, and still exactly what we last wrote. */
const isUntouched = (c: RemoteComment, record: PublicationRecord, ctx: PublishContext): boolean =>
  isOurs(c, ctx, record.entryId) && c.body === record.lastBody

async function save(
  ctx: PublishContext,
  record: PublicationRecord,
  next: Partial<PublicationRecord>,
): Promise<PublicationRecord | null> {
  const updated = { ...record, ...next }
  return (await ctx.journal.save(updated)) ? updated : null
}

/**
 * Publish or update one entry-day. `values` null means retire: the entry was
 * deleted or moved away from this destination.
 */
export async function reconcilePublication(
  ctx: PublishContext,
  key: PublicationKey,
  sourceVersion: number,
  values: PublishedValues | null,
): Promise<PublicationResult> {
  const claimed = await ctx.journal.claim(key, sourceVersion)
  if (claimed === null) return { outcome: 'busy', code: null }
  try {
    return await run(ctx, claimed, values)
  } finally {
    await ctx.journal.release(key, claimed.fence)
  }
}

async function run(
  ctx: PublishContext,
  start: PublicationRecord,
  values: PublishedValues | null,
): Promise<PublicationResult> {
  let record = start
  const fenced: PublicationResult = { outcome: 'fenced', code: 'stale_fence' }
  const hold = async (
    status: PublicationStatus,
    outcome: PublishOutcome,
    code: string,
    extra: Partial<PublicationRecord> = {},
  ) => {
    const saved = await save(ctx, record, { status, ...extra })
    return saved === null ? fenced : { outcome, code }
  }
  // Only an operator clears a conflict; a retired row simply starts over if the entry returns.
  if (record.status === 'conflicted') return { outcome: 'conflicted', code: null }
  if (record.retryAt !== null && ctx.now() < record.retryAt)
    return { outcome: 'deferred', code: 'cooldown' }

  let sentCreate = false
  try {
    // Reconcile an unknown create before anything else.
    if (record.remoteId === null && record.attemptedAt !== null) {
      const listing = await ctx.surface.listComments(record.itemId)
      const matches = listing.comments.filter((c) => isOurs(c, ctx, record.entryId))
      if (matches.length > 1) return hold('ambiguous', 'ambiguous', 'duplicate_marker')
      if (matches.length === 1) {
        const found = matches[0]!
        const saved = await save(ctx, record, {
          status: 'published',
          remoteId: found.id,
          lastBody: found.body,
        })
        if (saved === null) return fenced
        record = saved
        const same =
          values !== null && found.body === renderTimeComment(ctx.marker, record.entryId, values)
        if (same) {
          const done = await save(ctx, record, { lastPublished: values })
          return done === null ? fenced : { outcome: 'adopted', code: null }
        }
      } else {
        const settled =
          record.attemptedAt !== null && ctx.now() - record.attemptedAt >= ctx.settleMs
        if (!listing.complete || !settled) return hold('ambiguous', 'ambiguous', 'absence_unproven')
        const reset = await save(ctx, record, { status: 'pending', attemptedAt: null })
        if (reset === null) return fenced
        record = reset
      }
    }

    if (record.remoteId === null) {
      if (values === null) return hold('retired', 'unchanged', 'never_published')
      const body = renderTimeComment(ctx.marker, record.entryId, values)
      // Journal the attempt durably before the POST is sent.
      const attempted = await save(ctx, record, { status: 'attempted', attemptedAt: ctx.now() })
      if (attempted === null) return fenced
      record = attempted
      sentCreate = true
      const created = await ctx.surface.createComment(record.itemId, body)
      const saved = await save(ctx, record, {
        status: 'published',
        remoteId: created.id,
        lastBody: body,
        lastPublished: values,
        attemptedAt: null,
      })
      return saved === null ? fenced : { outcome: 'created', code: null }
    }

    const remote = await ctx.surface.getComment(record.itemId, record.remoteId)
    if (remote === null) return hold('conflicted', 'conflicted', 'remote_removed')
    if (!isUntouched(remote, record, ctx)) return hold('conflicted', 'conflicted', 'remote_edited')

    if (values === null) {
      await ctx.surface.deleteComment(record.itemId, record.remoteId)
      return hold('retired', 'deleted', '', { remoteId: null, lastBody: null, lastPublished: null })
    }
    const body = renderTimeComment(ctx.marker, record.entryId, values)
    if (body === remote.body) return hold('published', 'unchanged', '', { lastPublished: values })
    const updated = await ctx.surface.updateComment(record.itemId, record.remoteId, body)
    return hold('published', 'updated', '', { lastBody: updated.body, lastPublished: values })
  } catch (e) {
    if (e instanceof CooldownError) {
      // A refused create (429) did not land, so the attempt is withdrawn; a refused
      // reconcile leaves the earlier unknown attempt in place.
      const extra = sentCreate ? { attemptedAt: null } : {}
      return hold('deferred', 'deferred', 'cooldown', {
        retryAt: ctx.now() + e.retryAfterMs,
        ...extra,
      })
    }
    // An ambiguous create stays 'attempted' so the next run reconciles before retrying.
    if (e instanceof AmbiguousWriteError) return { outcome: 'ambiguous', code: 'ambiguous_write' }
    throw e
  }
}
