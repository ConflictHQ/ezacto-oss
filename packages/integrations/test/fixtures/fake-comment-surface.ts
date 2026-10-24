import {
  AmbiguousWriteError,
  CooldownError,
  type CommentListing,
  type CommentSurface,
  type PublicationJournal,
  type PublicationKey,
  type PublicationRecord,
  type RemoteComment,
} from '../../src/work-items/publication.js'

/** In-memory issue comments with fault injection. POST is deliberately NOT idempotent. */
export class FakeCommentSurface implements CommentSurface {
  readonly appAuthorId = 'app'
  readonly comments = new Map<string, RemoteComment & { itemId: string }>()
  creates = 0
  /** Next create lands remotely, then throws as if the response was lost. */
  timeoutAfterWrite = false
  /** Next create throws without landing. */
  timeoutBeforeWrite = false
  /** Next update or delete: 'after' lands then throws, 'before' throws without landing. */
  updateFault: 'before' | 'after' | null = null
  deleteFault: 'before' | 'after' | null = null
  cooldownMs: number | null = null
  truncated = false
  private seq = 0

  async listComments(itemId: string): Promise<CommentListing> {
    this.rateLimit()
    const comments = [...this.comments.values()].filter((c) => c.itemId === itemId)
    return { comments: this.truncated ? [] : comments, complete: !this.truncated }
  }

  async getComment(itemId: string, id: string): Promise<RemoteComment | null> {
    this.rateLimit()
    const c = this.comments.get(id)
    return c !== undefined && c.itemId === itemId ? c : null
  }

  async createComment(itemId: string, body: string): Promise<RemoteComment> {
    this.rateLimit()
    if (this.timeoutBeforeWrite) {
      this.timeoutBeforeWrite = false
      throw new AmbiguousWriteError()
    }
    const c = { id: `c${++this.seq}`, itemId, authorId: this.appAuthorId, body }
    this.comments.set(c.id, c)
    this.creates++
    if (this.timeoutAfterWrite) {
      this.timeoutAfterWrite = false
      throw new AmbiguousWriteError()
    }
    return c
  }

  async updateComment(itemId: string, id: string, body: string): Promise<RemoteComment> {
    const c = this.comments.get(id)
    if (c === undefined || c.itemId !== itemId) throw new Error('not_found')
    const fault = this.updateFault
    this.updateFault = null
    if (fault === 'before') throw new AmbiguousWriteError()
    const next = { ...c, body }
    this.comments.set(id, next)
    if (fault === 'after') throw new AmbiguousWriteError()
    return next
  }

  async deleteComment(_itemId: string, id: string): Promise<void> {
    const fault = this.deleteFault
    this.deleteFault = null
    if (fault === 'before') throw new AmbiguousWriteError()
    this.comments.delete(id)
    if (fault === 'after') throw new AmbiguousWriteError()
  }

  private rateLimit(): void {
    if (this.cooldownMs !== null) throw new CooldownError(this.cooldownMs)
  }
}

const k = (key: PublicationKey): string => `${key.connectionId}|${key.entryId}|${key.itemId}`

/** Journal with the semantics SQLite/D1 must reproduce: one row per key, exclusive claim, fences. */
export class FakePublicationJournal implements PublicationJournal {
  readonly rows = new Map<string, PublicationRecord>()
  private readonly claimed = new Set<string>()
  readonly revoked = new Set<string>()
  /** Called once after the next claim, to simulate another worker or a disconnect mid-run. */
  afterClaim: (() => void) | null = null

  async claim(key: PublicationKey, sourceVersion: number): Promise<PublicationRecord | null> {
    const id = k(key)
    if (this.claimed.has(id) || this.revoked.has(key.connectionId)) return null
    this.claimed.add(id)
    const prior = this.rows.get(id)
    const row: PublicationRecord = {
      status: 'pending',
      remoteId: null,
      lastBody: null,
      lastPublished: null,
      attemptedAt: null,
      retryAt: null,
      pendingWrite: null,
      ...prior,
      ...key,
      sourceVersion: Math.max(prior?.sourceVersion ?? 0, sourceVersion),
      fence: (prior?.fence ?? 0) + 1,
    }
    this.rows.set(id, row)
    const hook = this.afterClaim
    this.afterClaim = null
    hook?.()
    return row
  }

  async save(record: PublicationRecord): Promise<boolean> {
    const id = k(record)
    const current = this.rows.get(id)
    if (
      current === undefined ||
      current.fence !== record.fence ||
      this.revoked.has(record.connectionId)
    )
      return false
    this.rows.set(id, record)
    return true
  }

  async release(key: PublicationKey): Promise<void> {
    this.claimed.delete(k(key))
  }
}
