import {
  GithubStoreFencedError,
  mergeGithubRemoteItem,
  type GithubBackfillCheckpoint,
  type GithubMergeOutcome,
  type GithubReadReconciliation,
  type GithubReadStore,
  type GithubRemoteItem,
  type GithubResourceState,
} from '../../src/work-items/github-read.js'

/** In-memory reference implementation of the store contract. Not for production. */
export class FakeGithubReadStore implements GithubReadStore {
  private readonly items = new Map<string, GithubRemoteItem>()
  private readonly deliveries = new Set<string>()
  private readonly checkpoints = new Map<string, GithubBackfillCheckpoint>()
  private readonly resources = new Map<string, GithubResourceState>()
  private readonly cooldowns = new Map<string, number>()
  private readonly fences = new Map<string, 'disconnecting' | 'disconnected' | 'revoked'>()
  /** Test hook: throw on the n-th applied item of a batch to prove atomicity. */
  failBatchAtItem: number | null = null

  private fenced(connectionId: string): void {
    if (this.fences.has(connectionId)) throw new GithubStoreFencedError()
  }

  async recordDelivery(connectionId: string, deliveryId: string): Promise<'new' | 'duplicate'> {
    this.fenced(connectionId)
    const key = `${connectionId}\u0000${deliveryId}`
    if (this.deliveries.has(key)) return 'duplicate'
    this.deliveries.add(key)
    return 'new'
  }

  async getItemByAlias(connectionId: string, alias: string): Promise<GithubRemoteItem | null> {
    const wanted = alias.toLowerCase()
    const matches: GithubRemoteItem[] = []
    for (const item of this.items.values()) {
      if (item.connectionId === connectionId && item.aliases.includes(wanted)) matches.push(item)
    }
    return matches.length === 1 && new Set(matches.map((i) => i.repositoryId)).size === 1
      ? (matches[0] ?? null)
      : null
  }

  async getItem(connectionId: string, issueId: string): Promise<GithubRemoteItem | null> {
    return this.items.get(`${connectionId}\u0000${issueId}`) ?? null
  }

  async applyItem(item: GithubRemoteItem): Promise<GithubMergeOutcome> {
    this.fenced(item.connectionId)
    const key = `${item.connectionId}\u0000${item.issueId}`
    const merged = mergeGithubRemoteItem(this.items.get(key) ?? null, item)
    this.items.set(key, merged.item)
    return merged.outcome
  }

  async applyBatch(input: Parameters<GithubReadStore['applyBatch']>[0]) {
    this.fenced(input.connectionId)
    for (const item of input.items) {
      if (item.connectionId !== input.connectionId || item.repositoryId !== input.repositoryId) {
        throw new RangeError('A batch holds only items of its own connection and repository.')
      }
    }
    const cpKey = `${input.connectionId}\u0000${input.repositoryId}`
    const current = this.checkpoints.get(cpKey)
    if ((current?.version ?? 0) !== input.expectedVersion) return { outcome: 'conflict' as const }
    const staged = new Map(this.items)
    input.items.forEach((item, index) => {
      if (this.failBatchAtItem === index) throw new Error('simulated crash')
      const key = `${item.connectionId}\u0000${item.issueId}`
      staged.set(key, mergeGithubRemoteItem(staged.get(key) ?? null, item).item)
    })
    this.items.clear()
    for (const [k, v] of staged) this.items.set(k, v)
    const checkpoint: GithubBackfillCheckpoint = {
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      cursor: input.next.cursor,
      watermark: input.next.watermark,
      status: input.next.status,
      version: input.expectedVersion + 1,
    }
    this.checkpoints.set(cpKey, checkpoint)
    return { outcome: 'applied' as const, checkpoint }
  }

  async getCheckpoint(connectionId: string, repositoryId: string) {
    return this.checkpoints.get(`${connectionId}\u0000${repositoryId}`) ?? null
  }

  async setResourceState(connectionId: string, repositoryId: string, state: GithubResourceState) {
    this.fenced(connectionId)
    this.resources.set(`${connectionId}\u0000${repositoryId}`, state)
    for (const [key, item] of this.items) {
      if (item.connectionId !== connectionId || item.repositoryId !== repositoryId) continue
      this.items.set(key, {
        ...item,
        status: state === 'active' || state === 'renamed' ? item.status : 'unavailable',
      })
    }
  }

  async recordRepositoryName(connectionId: string, repositoryId: string, fullName: string) {
    this.fenced(connectionId)
    for (const [key, item] of this.items) {
      if (item.connectionId !== connectionId || item.repositoryId !== repositoryId) continue
      const alias = `${fullName.toLowerCase()}#${item.number}`
      if (!item.aliases.includes(alias))
        this.items.set(key, { ...item, aliases: [...item.aliases, alias] })
    }
    this.resources.set(`${connectionId}\u0000${repositoryId}`, 'renamed')
  }

  async setCooldown(connectionId: string, notBefore: number) {
    this.fenced(connectionId)
    this.cooldowns.set(connectionId, Math.max(this.cooldowns.get(connectionId) ?? 0, notBefore))
  }

  async fence(connectionId: string, state: 'disconnecting' | 'disconnected' | 'revoked') {
    this.fences.set(connectionId, state)
  }

  async reconciliation(connectionId: string): Promise<GithubReadReconciliation> {
    const items = [...this.items.values()].filter((i) => i.connectionId === connectionId)
    const repositoryIds = new Set<string>()
    for (const k of [...this.resources.keys(), ...this.checkpoints.keys()]) {
      const [c, r] = k.split('\u0000')
      if (c === connectionId && r !== undefined) repositoryIds.add(r)
    }
    for (const i of items) repositoryIds.add(i.repositoryId)
    return {
      connectionId,
      connectionState: this.fences.get(connectionId) ?? 'active',
      resources: [...repositoryIds].map((repositoryId) => ({
        repositoryId,
        state: this.resources.get(`${connectionId}\u0000${repositoryId}`) ?? 'active',
        checkpoint: this.checkpoints.get(`${connectionId}\u0000${repositoryId}`) ?? null,
        lastAppliedAt: null,
      })),
      deferredUntil: this.cooldowns.get(connectionId) ?? null,
      failureCodes: [],
      itemsVisible: items.filter((i) => i.status === 'visible').length,
      itemsUnavailable: items.filter((i) => i.status === 'unavailable').length,
    }
  }
}
