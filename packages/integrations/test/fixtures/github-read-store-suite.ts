import { describe, expect, it } from 'vitest'
import {
  GithubStoreFencedError,
  type GithubReadStore,
  type GithubRemoteItem,
} from '../../src/work-items/github-read.js'

const item = (over: Partial<GithubRemoteItem> = {}): GithubRemoteItem => ({
  connectionId: 'c1',
  issueId: '1001',
  repositoryId: '77',
  number: 5,
  canonicalUrl: 'https://github.com/acme/app/issues/5',
  title: 'Original',
  state: 'open',
  remoteUpdatedAt: '2026-10-01T10:00:00Z',
  aliases: ['acme/app#5'],
  status: 'visible',
  ...over,
})

/**
 * The acceptance suite any real `GithubReadStore` (SQLite and D1 alike) must pass.
 * `crashOnBatchItem(store, n)` makes the n-th item of the next `applyBatch` fail
 * after earlier items were staged, to prove a batch is all-or-nothing.
 */
export const describeGithubReadStore = (
  name: string,
  make: () => Promise<GithubReadStore> | GithubReadStore,
  crashOnBatchItem: (store: GithubReadStore, index: number) => void,
): void => {
  describe(`github read store contract: ${name}`, () => {
    it('[unit] journals a delivery id once per connection', async () => {
      const store = await make()
      expect(await store.recordDelivery('c1', 'd-1')).toBe('new')
      expect(await store.recordDelivery('c1', 'd-1')).toBe('duplicate')
      expect(await store.recordDelivery('c2', 'd-1')).toBe('new')
    })

    it('[unit] ignores an out-of-order older revision and keeps aliases', async () => {
      const store = await make()
      expect(
        await store.applyItem(item({ title: 'New', remoteUpdatedAt: '2026-10-02T00:00:00Z' })),
      ).toBe('inserted')
      expect(
        await store.applyItem(item({ title: 'Old', remoteUpdatedAt: '2026-10-01T00:00:00Z' })),
      ).toBe('stale')
      expect((await store.getItem('c1', '1001'))?.title).toBe('New')
      expect(
        await store.applyItem(
          item({
            title: 'Newer',
            remoteUpdatedAt: '2026-10-03T00:00:00Z',
            aliases: ['acme/renamed#5'],
          }),
        ),
      ).toBe('updated')
      const stored = await store.getItem('c1', '1001')
      expect(stored?.aliases).toEqual(['acme/app#5', 'acme/renamed#5'])
      expect((await store.getItemByAlias('c1', 'ACME/Renamed#5'))?.issueId).toBe('1001')
    })

    it('[security] never resolves an item through another connection', async () => {
      const store = await make()
      await store.applyItem(item())
      expect(await store.getItem('c2', '1001')).toBeNull()
      expect(await store.getItemByAlias('c2', 'acme/app#5')).toBeNull()
    })

    it('[unit] advances the checkpoint only with an applied batch, by version', async () => {
      const store = await make()
      const next = { cursor: '2', watermark: null, status: 'running' as const }
      const first = await store.applyBatch({
        connectionId: 'c1',
        repositoryId: '77',
        expectedVersion: 0,
        items: [item()],
        next,
      })
      expect(first).toMatchObject({ outcome: 'applied', checkpoint: { version: 1, cursor: '2' } })
      const stale = await store.applyBatch({
        connectionId: 'c1',
        repositoryId: '77',
        expectedVersion: 0,
        items: [item({ issueId: '2' })],
        next: { ...next, cursor: '3' },
      })
      expect(stale).toEqual({ outcome: 'conflict' })
      expect(await store.getItem('c1', '2')).toBeNull()
      expect((await store.getCheckpoint('c1', '77'))?.cursor).toBe('2')
    })

    it('[unit] a batch that crashes midway applies nothing and does not advance', async () => {
      const store = await make()
      crashOnBatchItem(store, 1)
      await expect(
        store.applyBatch({
          connectionId: 'c1',
          repositoryId: '77',
          expectedVersion: 0,
          items: [item({ issueId: '1' }), item({ issueId: '2' })],
          next: { cursor: '2', watermark: null, status: 'running' },
        }),
      ).rejects.toThrow()
      expect(await store.getItem('c1', '1')).toBeNull()
      expect(await store.getCheckpoint('c1', '77')).toBeNull()
    })

    it('[unit] a lost repository makes items unavailable but keeps them', async () => {
      const store = await make()
      await store.applyItem(item())
      await store.setResourceState('c1', '77', 'access_lost')
      expect((await store.getItem('c1', '1001'))?.status).toBe('unavailable')
      const report = await store.reconciliation('c1')
      expect(report.itemsUnavailable).toBe(1)
      expect(report.resources[0]?.state).toBe('access_lost')
    })

    it('[unit] a rename adds an alias without a new item', async () => {
      const store = await make()
      await store.applyItem(item())
      await store.recordRepositoryName('c1', '77', 'Acme/Renamed')
      expect((await store.getItemByAlias('c1', 'acme/renamed#5'))?.issueId).toBe('1001')
      expect((await store.reconciliation('c1')).itemsVisible).toBe(1)
    })

    it('[unit] a cooldown is durable and never shortened', async () => {
      const store = await make()
      await store.setCooldown('c1', 5000)
      await store.setCooldown('c1', 1000)
      expect((await store.reconciliation('c1')).deferredUntil).toBe(5000)
    })

    it('[security] fencing refuses new deliveries, items and batches, idempotently', async () => {
      const store = await make()
      await store.fence('c1', 'disconnecting')
      await store.fence('c1', 'disconnected')
      await expect(store.recordDelivery('c1', 'd-9')).rejects.toBeInstanceOf(GithubStoreFencedError)
      await expect(store.applyItem(item())).rejects.toBeInstanceOf(GithubStoreFencedError)
      await expect(
        store.applyBatch({
          connectionId: 'c1',
          repositoryId: '77',
          expectedVersion: 0,
          items: [],
          next: { cursor: null, watermark: null, status: 'complete' },
        }),
      ).rejects.toBeInstanceOf(GithubStoreFencedError)
      expect((await store.reconciliation('c1')).connectionState).toBe('disconnected')
      expect(await store.recordDelivery('c2', 'd-9')).toBe('new')
    })
  })
}
