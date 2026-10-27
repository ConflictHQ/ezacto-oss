import { describe, expect, it } from 'vitest'
import {
  reconcilePublication,
  renderTimeComment,
  type PublishContext,
} from '../src/work-items/publication.js'
import { FakeCommentSurface, FakePublicationJournal } from './fixtures/fake-comment-surface.js'

const key = { connectionId: 'conn', entryId: 'e1', itemId: 'o/r#1' }
const day = { spentDate: '2026-10-01', seconds: 5400 }

function setup() {
  const surface = new FakeCommentSurface()
  const journal = new FakePublicationJournal()
  let t = 1_000
  const ctx: PublishContext = {
    surface,
    journal,
    marker: 'm-secret',
    now: () => t,
    settleMs: 60_000,
  }
  return { surface, journal, ctx, advance: (ms: number) => (t += ms) }
}

describe('opt-in time publication contract (fake)', () => {
  it('[unit] renders only the day and seconds', () => {
    const body = renderTimeComment('m', 'e1', day)
    expect(body).toBe('<!-- ezacto-time:m:e1 -->\nTime logged: 1h 30m on 2026-10-01')
  })

  it('[unit] creates once and replay is unchanged', async () => {
    const { surface, ctx } = setup()
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('created')
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('unchanged')
    expect(surface.creates).toBe(1)
  })

  it('[unit] timeout after a successful write adopts the comment instead of posting twice', async () => {
    const { surface, ctx, advance } = setup()
    surface.timeoutAfterWrite = true
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('ambiguous')
    advance(1)
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('adopted')
    expect(surface.creates).toBe(1)
  })

  it('[unit] holds when absence cannot be proved, then retries once it can', async () => {
    const { surface, ctx, advance } = setup()
    surface.timeoutBeforeWrite = true
    await reconcilePublication(ctx, key, 1, day)
    expect(await reconcilePublication(ctx, key, 1, day)).toEqual({
      outcome: 'ambiguous',
      code: 'absence_unproven',
    })
    expect(surface.creates).toBe(0)
    advance(60_000)
    surface.truncated = true
    expect((await reconcilePublication(ctx, key, 1, day)).code).toBe('absence_unproven')
    surface.truncated = false
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('created')
    expect(surface.creates).toBe(1)
  })

  it('[unit] ignores a lookalike marker from another author', async () => {
    const { surface, ctx, advance } = setup()
    surface.comments.set('x', {
      id: 'x',
      itemId: key.itemId,
      authorId: 'human',
      body: renderTimeComment('m-secret', 'e1', day),
    })
    surface.timeoutBeforeWrite = true
    await reconcilePublication(ctx, key, 1, day)
    advance(60_000)
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('created')
  })

  it('[unit] permits only one automatic retry after complete settled absence', async () => {
    const {surface,ctx,advance}=setup()
    surface.timeoutBeforeWrite=true
    await reconcilePublication(ctx,key,1,day)
    advance(60000)
    surface.timeoutBeforeWrite=true
    await reconcilePublication(ctx,key,1,day)
    advance(60000)
    expect((await reconcilePublication(ctx,key,1,day)).outcome).toBe('failed')
    expect((await reconcilePublication(ctx,key,1,day)).outcome).toBe('failed')
    expect(surface.creates).toBe(0)
  })
  it('[unit] human edits after an unknown create remain a conflict', async () => {
    const {surface,ctx}=setup()
    surface.timeoutAfterWrite=true
    await reconcilePublication(ctx,key,1,day)
    const [id,comment]=[...surface.comments.entries()][0]!
    surface.comments.set(id,{...comment,body:comment.body+'\nHuman edit'})
    expect((await reconcilePublication(ctx,key,1,day)).outcome).toBe('conflicted')
    expect(surface.comments.get(id)?.body).toContain('Human edit')
    expect(surface.creates).toBe(1)
  })

  it('[unit] two matching comments hold for an operator', async () => {
    const { surface, ctx, advance } = setup()
    for (const id of ['x', 'y'])
      surface.comments.set(id, {
        id,
        itemId: key.itemId,
        authorId: 'app',
        body: renderTimeComment('m-secret', 'e1', day),
      })
    surface.timeoutBeforeWrite = true
    await reconcilePublication(ctx, key, 1, day)
    advance(60_000)
    expect((await reconcilePublication(ctx, key, 1, day)).code).toBe('duplicate_marker')
  })

  it('[unit] concurrent workers: the second is refused while the first holds the claim', async () => {
    const { surface, ctx, journal } = setup()
    let second: Promise<unknown> | undefined
    journal.afterClaim = () => {
      second = reconcilePublication(ctx, key, 1, day)
    }
    const first = await reconcilePublication(ctx, key, 1, day)
    expect(await second).toEqual({ outcome: 'busy', code: null })
    expect(first.outcome).toBe('created')
    expect(surface.creates).toBe(1)
  })

  it('[unit] disconnect mid-run fences the write and the claim is refused afterwards', async () => {
    const { ctx, journal } = setup()
    journal.afterClaim = () => journal.revoked.add('conn')
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('fenced')
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('busy')
  })

  it('[unit] an authorized edit updates our own comment in place', async () => {
    const { surface, ctx } = setup()
    await reconcilePublication(ctx, key, 1, day)
    expect((await reconcilePublication(ctx, key, 2, { ...day, seconds: 7200 })).outcome).toBe(
      'updated',
    )
    expect([...surface.comments.values()][0]!.body).toContain('2h')
    expect(surface.creates).toBe(1)
  })

  it('[unit] a human edit or removal is a conflict, never overwritten or recreated', async () => {
    const a = setup()
    await reconcilePublication(a.ctx, key, 1, day)
    const c = [...a.surface.comments.values()][0]!
    a.surface.comments.set(c.id, { ...c, body: c.body + ' (fixed by hand)' })
    expect((await reconcilePublication(a.ctx, key, 2, { ...day, seconds: 60 })).code).toBe(
      'remote_edited',
    )
    expect((await reconcilePublication(a.ctx, key, 3, null)).outcome).toBe('conflicted')
    expect(a.surface.comments.get(c.id)!.body).toContain('fixed by hand')

    const b = setup()
    await reconcilePublication(b.ctx, key, 1, day)
    b.surface.comments.clear()
    expect((await reconcilePublication(b.ctx, key, 2, day)).code).toBe('remote_removed')
    expect(b.surface.creates).toBe(1)
  })

  it('[unit] retiring deletes only the verified untouched comment, and a return republishes', async () => {
    const { surface, ctx } = setup()
    await reconcilePublication(ctx, key, 1, day)
    expect((await reconcilePublication(ctx, key, 2, null)).outcome).toBe('deleted')
    expect(surface.comments.size).toBe(0)
    expect((await reconcilePublication(ctx, key, 3, day)).outcome).toBe('created')
  })

  it('[unit] a cooldown defers without writing and is respected until it passes', async () => {
    const { surface, ctx, advance } = setup()
    surface.cooldownMs = 30_000
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('deferred')
    surface.cooldownMs = null
    expect((await reconcilePublication(ctx, key, 1, day)).code).toBe('cooldown')
    expect(surface.creates).toBe(0)
    advance(30_000)
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('created')
  })

  it('[unit] an update that landed before a lost response is adopted, not a conflict', async () => {
    const { surface, ctx, journal } = setup()
    await reconcilePublication(ctx, key, 1, day)
    surface.updateFault = 'after'
    const next = { ...day, seconds: 7200 }
    expect((await reconcilePublication(ctx, key, 2, next)).outcome).toBe('ambiguous')
    expect((await reconcilePublication(ctx, key, 2, next)).outcome).toBe('unchanged')
    expect([...journal.rows.values()][0]!.status).toBe('published')
    expect([...journal.rows.values()][0]!.pendingWrite).toBeNull()
    expect([...surface.comments.values()][0]!.body).toContain('2h')
  })

  it('[unit] an update that did not land is retried, and a human edit meanwhile is still a conflict', async () => {
    const a = setup()
    await reconcilePublication(a.ctx, key, 1, day)
    a.surface.updateFault = 'before'
    const next = { ...day, seconds: 7200 }
    await reconcilePublication(a.ctx, key, 2, next)
    expect((await reconcilePublication(a.ctx, key, 2, next)).outcome).toBe('updated')

    const b = setup()
    await reconcilePublication(b.ctx, key, 1, day)
    b.surface.updateFault = 'before'
    await reconcilePublication(b.ctx, key, 2, next)
    const c = [...b.surface.comments.values()][0]!
    b.surface.comments.set(c.id, { ...c, body: c.body + ' (by hand)' })
    expect((await reconcilePublication(b.ctx, key, 2, next)).code).toBe('remote_edited')
  })

  it('[unit] a delete that landed before a lost response retires cleanly', async () => {
    const { surface, ctx, journal } = setup()
    await reconcilePublication(ctx, key, 1, day)
    surface.deleteFault = 'after'
    expect((await reconcilePublication(ctx, key, 2, null)).outcome).toBe('ambiguous')
    expect(surface.comments.size).toBe(0)
    expect((await reconcilePublication(ctx, key, 2, null)).outcome).toBe('deleted')
    expect([...journal.rows.values()][0]!.status).toBe('retired')
  })

  it('[unit] a delete that did not land is retried', async () => {
    const { surface, ctx } = setup()
    await reconcilePublication(ctx, key, 1, day)
    surface.deleteFault = 'before'
    await reconcilePublication(ctx, key, 2, null)
    expect(surface.comments.size).toBe(1)
    expect((await reconcilePublication(ctx, key, 2, null)).outcome).toBe('deleted')
    expect(surface.comments.size).toBe(0)
  })

  it('[unit] a lower sourceVersion cannot overwrite a newer one', async () => {
    const { surface, ctx, journal } = setup()
    await reconcilePublication(ctx, key, 5, { ...day, seconds: 7200 })
    const stale = await reconcilePublication(ctx, key, 3, { ...day, seconds: 60 })
    expect(stale).toEqual({ outcome: 'stale', code: 'stale_version' })
    expect([...surface.comments.values()][0]!.body).toContain('2h')
    expect([...journal.rows.values()][0]!.sourceVersion).toBe(5)
    expect((await reconcilePublication(ctx, key, 5, { ...day, seconds: 7200 })).outcome).toBe(
      'unchanged',
    )
  })

  it('[unit] ambiguous and deferred holds are visible in the journal', async () => {
    const { surface, ctx, journal, advance } = setup()
    surface.timeoutBeforeWrite = true
    await reconcilePublication(ctx, key, 1, day)
    await reconcilePublication(ctx, key, 1, day)
    expect([...journal.rows.values()][0]!.status).toBe('ambiguous')
    advance(60_000)
    surface.cooldownMs = 5_000
    await reconcilePublication(ctx, key, 1, day)
    const row = [...journal.rows.values()][0]!
    expect(row.status).toBe('deferred')
    expect(row.retryAt).toBe(1_000 + 60_000 + 5_000)
  })

  it('[unit] a cooldown during reconcile keeps the unknown attempt and adopts later without a second post', async () => {
    const { surface, ctx, journal, advance } = setup()
    surface.timeoutAfterWrite = true
    await reconcilePublication(ctx, key, 1, day)
    surface.cooldownMs = 10_000
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('deferred')
    expect([...journal.rows.values()][0]!.attemptedAt).not.toBeNull()
    surface.cooldownMs = null
    advance(10_000)
    expect((await reconcilePublication(ctx, key, 1, day)).outcome).toBe('adopted')
    expect(surface.creates).toBe(1)
    expect([...journal.rows.values()][0]!.retryAt).toBeNull()
  })
})
