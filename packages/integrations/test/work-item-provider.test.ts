import { describe, expect, it } from 'vitest'
import { FakeWorkItemProvider } from './fixtures/fake-work-item-provider.js'

/** What every provider shares, pinned against the fake before a real one exists. */
describe('work item provider contract (fake)', () => {
  it('[unit] answers null for an item it cannot see and a snapshot for one it can', async () => {
    const provider = new FakeWorkItemProvider()
    expect(await provider.fetchItem('o/r#1')).toBeNull()
    provider.items.set('o/r#1', {
      itemId: 'o/r#1',
      url: 'https://example.test/o/r/1',
      title: 'A',
      state: 'open',
    })
    expect(await provider.fetchItem('o/r#1')).toMatchObject({ itemId: 'o/r#1', state: 'open' })
  })

  it('[unit] posts a time note once however often the same key is replayed', async () => {
    const provider = new FakeWorkItemProvider()
    const note = {
      itemId: 'o/r#1',
      idempotencyKey: 'entry-9:2026-10-01',
      spentDate: '2026-10-01',
      seconds: 3600,
    }
    const first = await provider.postTimeNote(note)
    const replay = await provider.postTimeNote(note)
    const other = await provider.postTimeNote({ ...note, idempotencyKey: 'entry-9:2026-10-02' })
    expect(first.created).toBe(true)
    expect(replay).toEqual({ remoteId: first.remoteId, created: false })
    expect(other.remoteId).not.toBe(first.remoteId)
    expect(provider.notes.size).toBe(2)
  })

  it('[security] refuses a delivery with no signature or the wrong one', async () => {
    const provider = new FakeWorkItemProvider()
    expect(await provider.verifyWebhook({ headers: {}, body: '{}' })).toEqual({
      verified: false,
      reason: 'missing_signature',
    })
    expect(
      await provider.verifyWebhook({ headers: { 'x-fake-signature': 'nope' }, body: '{}' }),
    ).toEqual({ verified: false, reason: 'bad_signature' })
    expect(
      await provider.verifyWebhook({
        headers: { 'x-fake-signature': 'fake-secret', 'x-fake-delivery': 'd-1' },
        body: '{}',
      }),
    ).toEqual({ verified: true, deliveryId: 'd-1' })
  })
})
