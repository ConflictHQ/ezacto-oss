import {
  GithubStoreFencedError,
  type GithubBackfillCheckpoint,
  type GithubMergeOutcome,
  type GithubReadReconciliation,
  type GithubReadStore,
  type GithubRemoteItem,
  type GithubResourceState,
  type GithubReaderStore,
  type GithubStoredEffect,
} from '@ezacto/integrations'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

type Statement = { text: string; params: readonly unknown[] }
const statement = (text: string, ...params: unknown[]): Statement => ({ text, params })
const checkpoint = (row: Record<string, unknown>): GithubBackfillCheckpoint => ({
  connectionId: String(row.connection_id),
  repositoryId: String(row.repository_id),
  cursor: row.cursor === null ? null : String(row.cursor),
  watermark: row.watermark === null ? null : String(row.watermark),
  version: Number(row.version),
  status: row.status as 'running' | 'complete',
})
const metadata = (item: GithubRemoteItem): string =>
  JSON.stringify({
    connectionId: item.connectionId,
    issueId: item.issueId,
    repositoryId: item.repositoryId,
    number: item.number,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    state: item.state,
    remoteUpdatedAt: item.remoteUpdatedAt,
    aliases: [],
    status: item.status,
  })
const validId = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 128 &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32)
const assertItem = (item: GithubRemoteItem): void => {
  if (
    !validId(item.connectionId) ||
    !/^[1-9]\d{0,15}$/.test(item.issueId) ||
    !/^[1-9]\d{0,15}$/.test(item.repositoryId) ||
    item.title.length > 1024 ||
    item.aliases.length > 500 ||
    item.aliases.some((alias) => alias.length > 256) ||
    !Number.isSafeInteger(item.number) ||
    item.number < 1 ||
    !['open', 'closed'].includes(item.state) ||
    !['visible', 'unavailable'].includes(item.status)
  )
    throw new RangeError('Invalid GitHub metadata.')
}
/** Real SQLite/D1 store. Every write is one native transaction/batch; no provider
 * calls or asynchronous work runs inside a SQLite transaction. JSON is one
 * bounded metadata record per immutable issue, never one growing connection blob.
 */
export class NativeGithubReadStore implements GithubReaderStore {
  constructor(
    readonly database: InvoiceStateDatabase,
    private readonly binding?: { connectionId: string; generation: number },
  ) {}
  async #atomic(statements: readonly Statement[]): Promise<Record<string, unknown>[][]> {
    try {
      return await atomicStatements(this.database, statements)
    } catch (error) {
      // Classify only from current canonical facts after rollback. An unrelated
      // driver envelope may contain the sentinel in metadata or diagnostics.
      const guard = statements[0]
      if (
        guard?.text ===
        'INSERT INTO github_read_guards(token,connection_id,expected_generation) VALUES(?,?,?) RETURNING token'
      ) {
        try {
          const facts = (
            await atomicStatements(this.database, [
              statement(
                'SELECT state,generation FROM github_read_connections WHERE id=?',
                guard.params[1],
              ),
            ])
          )[0]?.[0]
          if (
            !facts ||
            facts.state !== 'active' ||
            (guard.params[2] !== null && Number(facts.generation) !== guard.params[2])
          )
            throw new GithubStoreFencedError()
        } catch (checkError) {
          if (checkError instanceof GithubStoreFencedError) throw checkError
          // A failed diagnostic read must never replace the original failure.
        }
      }
      throw error
    }
  }
  #guard(
    connectionId: string,
    statements: readonly Statement[],
    generation: number | null = this.binding?.generation ?? null,
  ): readonly Statement[] {
    if (this.binding && this.binding.connectionId !== connectionId)
      throw new GithubStoreFencedError()
    const token = crypto.randomUUID()
    return [
      statement(
        'INSERT INTO github_read_guards(token,connection_id,expected_generation) VALUES(?,?,?) RETURNING token',
        token,
        connectionId,
        generation,
      ),
      ...statements,
      statement('DELETE FROM github_read_guards WHERE token=? RETURNING token', token),
    ]
  }
  async #rows(text: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.#atomic([statement(text, ...params)]))[0] ?? []
  }
  async recordDelivery(connectionId: string, deliveryId: string): Promise<'new' | 'duplicate'> {
    if (!validId(deliveryId)) throw new RangeError('Invalid GitHub delivery ID.')
    const rows = await this.#atomic(
      this.#guard(connectionId, [
        statement(
          'INSERT INTO github_read_deliveries(connection_id,delivery_id) VALUES(?,?) ON CONFLICT DO NOTHING RETURNING delivery_id',
          connectionId,
          deliveryId,
        ),
      ]),
    )
    return rows[1]?.length === 1 ? 'new' : 'duplicate'
  }
  async getItem(connectionId: string, issueId: string): Promise<GithubRemoteItem | null> {
    const [row] = await this.#rows(
      `SELECT i.metadata,COALESCE((SELECT json_group_array(alias) FROM github_read_aliases a WHERE a.connection_id=i.connection_id AND a.issue_id=i.issue_id),'[]') aliases FROM github_read_items i WHERE i.connection_id=? AND i.issue_id=?`,
      connectionId,
      issueId,
    )
    return row
      ? {
          ...(JSON.parse(String(row.metadata)) as GithubRemoteItem),
          aliases: JSON.parse(String(row.aliases)) as string[],
        }
      : null
  }
  async getItemByAlias(connectionId: string, alias: string): Promise<GithubRemoteItem | null> {
    const rows = await this.#rows(
      'SELECT issue_id FROM github_read_aliases WHERE connection_id=? AND alias=? COLLATE NOCASE LIMIT 2',
      connectionId,
      alias,
    )
    return rows.length === 1 ? this.getItem(connectionId, String(rows[0]!.issue_id)) : null
  }
  #apply(item: GithubRemoteItem, condition = '1', bindings: readonly unknown[] = []): Statement[] {
    assertItem(item)
    const newer = `json_extract(excluded.metadata,'$.remoteUpdatedAt')>json_extract(github_read_items.metadata,'$.remoteUpdatedAt')`
    const equal = `json_extract(excluded.metadata,'$.remoteUpdatedAt')=json_extract(github_read_items.metadata,'$.remoteUpdatedAt')`
    const revived = `(json_extract(github_read_items.metadata,'$.status')='unavailable' AND ${equal})`
    return [
      statement(
        `INSERT INTO github_read_items(connection_id,issue_id,repository_id,metadata,outcome)
      SELECT ?,?,?,?,'inserted' WHERE ${condition}
      ON CONFLICT(connection_id,issue_id) DO UPDATE SET
        outcome=CASE WHEN ${newer} OR ${revived} THEN 'updated' WHEN excluded.metadata=github_read_items.metadata THEN 'unchanged' ELSE 'stale' END,
        metadata=CASE WHEN ${newer} OR ${revived} THEN excluded.metadata ELSE github_read_items.metadata END,
        repository_id=CASE WHEN ${newer} OR ${revived} THEN excluded.repository_id ELSE github_read_items.repository_id END
      RETURNING outcome`,
        item.connectionId,
        item.issueId,
        item.repositoryId,
        metadata(item),
        ...bindings,
      ),
      ...item.aliases.map((alias) =>
        statement(
          `INSERT INTO github_read_aliases(connection_id,issue_id,alias) SELECT ?,?,? WHERE ${condition} ON CONFLICT DO NOTHING RETURNING alias`,
          item.connectionId,
          item.issueId,
          alias.toLowerCase(),
          ...bindings,
        ),
      ),
    ]
  }
  async applyItem(item: GithubRemoteItem): Promise<GithubMergeOutcome> {
    const rows = await this.#atomic(this.#guard(item.connectionId, this.#apply(item)))
    return String(rows[1]?.[0]?.outcome) as GithubMergeOutcome
  }
  async applyBatch(input: Parameters<GithubReadStore['applyBatch']>[0]) {
    if (
      input.items.length > 100 ||
      input.items.some(
        (item) =>
          item.connectionId !== input.connectionId || item.repositoryId !== input.repositoryId,
      )
    )
      throw new RangeError('A batch holds at most 100 items of its own connection and repository.')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
      throw new RangeError('Invalid checkpoint version.')
    const token = crypto.randomUUID()
    const condition =
      'EXISTS(SELECT 1 FROM github_read_checkpoints WHERE connection_id=? AND repository_id=? AND token=?)'
    const bindings = [input.connectionId, input.repositoryId, token]
    const rows = await this.#atomic(
      this.#guard(input.connectionId, [
        statement(
          `INSERT INTO github_read_checkpoints(connection_id,repository_id,cursor,watermark,version,status,token)
        SELECT ?,?,?,?,?,?,? WHERE ?=0 ON CONFLICT(connection_id,repository_id) DO UPDATE SET
          cursor=excluded.cursor,watermark=excluded.watermark,version=excluded.version,status=excluded.status,token=excluded.token
          WHERE github_read_checkpoints.version=? RETURNING *`,
          input.connectionId,
          input.repositoryId,
          input.next.cursor,
          input.next.watermark,
          input.expectedVersion + 1,
          input.next.status,
          token,
          input.expectedVersion,
          input.expectedVersion,
        ),
        // Existing checkpoints with expectedVersion>0 need an UPDATE, not a filtered INSERT.
        statement(
          `UPDATE github_read_checkpoints SET cursor=?,watermark=?,version=version+1,status=?,token=? WHERE connection_id=? AND repository_id=? AND version=? AND ?<>0 RETURNING *`,
          input.next.cursor,
          input.next.watermark,
          input.next.status,
          token,
          input.connectionId,
          input.repositoryId,
          input.expectedVersion,
          input.expectedVersion,
        ),
        ...input.items.flatMap((item) => this.#apply(item, condition, bindings)),
      ]),
    )
    const applied = rows[1]?.[0] ?? rows[2]?.[0]
    return applied
      ? { outcome: 'applied' as const, checkpoint: checkpoint(applied) }
      : { outcome: 'conflict' as const }
  }
  async getCheckpoint(
    connectionId: string,
    repositoryId: string,
  ): Promise<GithubBackfillCheckpoint | null> {
    const [row] = await this.#rows(
      'SELECT * FROM github_read_checkpoints WHERE connection_id=? AND repository_id=?',
      connectionId,
      repositoryId,
    )
    return row ? checkpoint(row) : null
  }
  async setResourceState(
    connectionId: string,
    repositoryId: string,
    state: GithubResourceState,
  ): Promise<void> {
    await this.#atomic(
      this.#guard(connectionId, [
        statement(
          `INSERT INTO github_read_resources(connection_id,repository_id,state) VALUES(?,?,?) ON CONFLICT(connection_id,repository_id) DO UPDATE SET state=excluded.state RETURNING repository_id`,
          connectionId,
          repositoryId,
          state,
        ),
        statement(
          `UPDATE github_read_items SET metadata=json_set(metadata,'$.status','unavailable') WHERE connection_id=? AND repository_id=? AND ? NOT IN ('active','renamed') RETURNING issue_id`,
          connectionId,
          repositoryId,
          state,
        ),
      ]),
    )
  }
  async recordRepositoryName(
    connectionId: string,
    repositoryId: string,
    fullName: string,
  ): Promise<void> {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(fullName) || fullName.length > 140)
      throw new RangeError('Invalid repository name.')
    await this.#atomic(
      this.#guard(connectionId, [
        statement(
          `INSERT INTO github_read_aliases(connection_id,issue_id,alias) SELECT connection_id,issue_id,lower(?)||'#'||json_extract(metadata,'$.number') FROM github_read_items WHERE connection_id=? AND repository_id=? ON CONFLICT DO NOTHING RETURNING alias`,
          fullName,
          connectionId,
          repositoryId,
        ),
        statement(
          `INSERT INTO github_read_resources(connection_id,repository_id,full_name,state) VALUES(?,?,?,'renamed') ON CONFLICT(connection_id,repository_id) DO UPDATE SET full_name=excluded.full_name,state='renamed' RETURNING repository_id`,
          connectionId,
          repositoryId,
          fullName,
        ),
      ]),
    )
  }
  async enqueueDelivery(
    connectionId: string,
    deliveryId: string,
    bodyHash: string,
    effects: readonly GithubStoredEffect[],
  ): Promise<'pending' | 'applied'> {
    if (!validId(deliveryId) || !/^[a-f0-9]{64}$/.test(bodyHash) || effects.length > 100)
      throw new RangeError('Invalid GitHub delivery metadata.')
    const [existing] = await this.#rows(
      'SELECT body_hash,state FROM github_read_deliveries WHERE connection_id=? AND delivery_id=?',
      connectionId,
      deliveryId,
    )
    if (existing?.state === 'applied') {
      if (existing.body_hash !== bodyHash)
        throw new RangeError('GitHub delivery identity was reused.')
      return 'applied'
    }
    const encoded = JSON.stringify(effects)
    if (encoded.length > 1_048_576)
      throw new RangeError('GitHub delivery metadata exceeds its bound.')
    const rows = await this.#atomic(
      this.#guard(connectionId, [
        statement(
          `INSERT INTO github_read_deliveries(connection_id,delivery_id,body_hash,effect,generation) SELECT ?,?,?,?,generation FROM github_read_connections WHERE id=? ON CONFLICT DO NOTHING RETURNING delivery_id`,
          connectionId,
          deliveryId,
          bodyHash,
          encoded,
          connectionId,
        ),
        statement(
          'SELECT body_hash,state FROM github_read_deliveries WHERE connection_id=? AND delivery_id=?',
          connectionId,
          deliveryId,
        ),
      ]),
    )
    const row = rows[2]?.[0]
    if (!row || row.body_hash !== bodyHash)
      throw new RangeError('GitHub delivery identity was reused.')
    return row.state as 'pending' | 'applied'
  }
  async applyDelivery(connectionId: string, deliveryId: string): Promise<'applied' | 'duplicate'> {
    const [row] = await this.#rows(
      'SELECT body_hash,effect,state,generation FROM github_read_deliveries WHERE connection_id=? AND delivery_id=?',
      connectionId,
      deliveryId,
    )
    if (row?.state === 'applied') return 'duplicate'
    if (!row || row.effect === null)
      throw new RangeError('GitHub delivery has no verified metadata.')
    const effects = JSON.parse(String(row.effect)) as GithubStoredEffect[]
    const condition = `EXISTS(SELECT 1 FROM github_read_deliveries WHERE connection_id=? AND delivery_id=? AND body_hash=? AND state='pending')`
    const bindings = [connectionId, deliveryId, row.body_hash]
    const statements: Statement[] = []
    for (const effect of effects) {
      switch (effect.kind) {
        case 'item':
          if (effect.item.connectionId !== connectionId)
            throw new RangeError('Foreign GitHub connection.')
          statements.push(...this.#apply(effect.item, condition, bindings))
          break
        case 'removed':
          statements.push(
            statement(
              `UPDATE github_read_items SET metadata=json_set(metadata,'$.status','unavailable') WHERE connection_id=? AND repository_id=? AND issue_id=? AND ${condition} RETURNING issue_id`,
              connectionId,
              effect.repositoryId,
              effect.issueId,
              ...bindings,
            ),
          )
          break
        case 'resource':
          statements.push(
            statement(
              `UPDATE github_read_resources SET state=? WHERE connection_id=? AND repository_id=? AND ${condition} RETURNING repository_id`,
              effect.state,
              connectionId,
              effect.repositoryId,
              ...bindings,
            ),
            statement(
              `UPDATE github_read_items SET metadata=json_set(metadata,'$.status','unavailable') WHERE connection_id=? AND repository_id=? AND ${condition} RETURNING issue_id`,
              connectionId,
              effect.repositoryId,
              ...bindings,
            ),
          )
          break
        case 'rename':
          statements.push(
            statement(
              `UPDATE github_read_resources SET state='renamed',full_name=? WHERE connection_id=? AND repository_id=? AND ${condition} RETURNING repository_id`,
              effect.fullName,
              connectionId,
              effect.repositoryId,
              ...bindings,
            ),
            statement(
              `INSERT INTO github_read_aliases(connection_id,issue_id,alias) SELECT connection_id,issue_id,lower(?)||'#'||json_extract(metadata,'$.number') FROM github_read_items WHERE connection_id=? AND repository_id=? AND ${condition} ON CONFLICT DO NOTHING RETURNING alias`,
              effect.fullName,
              connectionId,
              effect.repositoryId,
              ...bindings,
            ),
          )
          break
        case 'revoke':
          statements.push(
            statement(
              `UPDATE github_read_connections SET state='revoked',generation=generation+1 WHERE id=? AND ${condition} RETURNING id`,
              connectionId,
              ...bindings,
            ),
          )
          break
        case 'ignored':
          break
      }
    }
    statements.push(
      statement(
        `UPDATE github_read_deliveries SET state='applied',effect=NULL WHERE connection_id=? AND delivery_id=? AND body_hash=? AND state='pending' RETURNING delivery_id`,
        ...bindings,
      ),
    )
    const result = await this.#atomic(this.#guard(connectionId, statements, Number(row.generation)))
    return result[statements.length]?.length === 1 ? 'applied' : 'duplicate'
  }
  async setCooldown(connectionId: string, notBefore: number): Promise<void> {
    if (!Number.isSafeInteger(notBefore) || notBefore < 0) throw new RangeError('Invalid cooldown.')
    await this.#atomic(
      this.#guard(connectionId, [
        statement(
          'UPDATE github_read_connections SET cooldown=max(COALESCE(cooldown,0),?) WHERE id=? RETURNING id',
          notBefore,
          connectionId,
        ),
      ]),
    )
  }
  async fence(
    connectionId: string,
    state: 'disconnecting' | 'disconnected' | 'revoked',
  ): Promise<void> {
    await this.#rows(
      'UPDATE github_read_connections SET state=?,generation=generation+CASE WHEN state<>? THEN 1 ELSE 0 END WHERE id=? RETURNING id',
      state,
      state,
      connectionId,
    )
  }
  async reconciliation(connectionId: string): Promise<GithubReadReconciliation> {
    const rows = await this.#atomic([
      statement(
        'SELECT state,cooldown,failure_code FROM github_read_connections WHERE id=?',
        connectionId,
      ),
      statement(
        `SELECT repository_id FROM github_read_resources WHERE connection_id=? UNION SELECT repository_id FROM github_read_items WHERE connection_id=? UNION SELECT repository_id FROM github_read_checkpoints WHERE connection_id=?`,
        connectionId,
        connectionId,
        connectionId,
      ),
      statement('SELECT * FROM github_read_resources WHERE connection_id=?', connectionId),
      statement('SELECT * FROM github_read_checkpoints WHERE connection_id=?', connectionId),
      statement(
        `SELECT json_extract(metadata,'$.status') status,count(*) count FROM github_read_items WHERE connection_id=? GROUP BY status`,
        connectionId,
      ),
    ])
    const connection = rows[0]?.[0]
    if (!connection) throw new GithubStoreFencedError()
    return {
      connectionId,
      connectionState: connection.state as GithubReadReconciliation['connectionState'],
      deferredUntil: connection.cooldown === null ? null : Number(connection.cooldown),
      failureCodes: connection.failure_code === null ? [] : [String(connection.failure_code)],
      itemsVisible: Number(rows[4]?.find((row) => row.status === 'visible')?.count ?? 0),
      itemsUnavailable: Number(rows[4]?.find((row) => row.status === 'unavailable')?.count ?? 0),
      resources: (rows[1] ?? []).map((row) => {
        const resource = rows[2]?.find((resource) => resource.repository_id === row.repository_id)
        const cp = rows[3]?.find((cp) => cp.repository_id === row.repository_id)
        return {
          repositoryId: String(row.repository_id),
          state: (resource?.state ?? 'active') as GithubResourceState,
          checkpoint: cp ? checkpoint(cp) : null,
          lastAppliedAt: null,
        }
      }),
    }
  }
}
