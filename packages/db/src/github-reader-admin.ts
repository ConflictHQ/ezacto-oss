import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import {
  GithubReaderCommandError,
  parseGithubIssueReference,
  type GithubReaderBinding,
} from '@ezacto/integrations'

export interface GithubReaderAuthority {
  readonly userId: number
  readonly sessionId: number
}
export class GithubReaderAdminError extends GithubReaderCommandError {
  constructor(readonly code: 'forbidden' | 'conflict' | 'command_reused' | 'invalid') {
    super(code)
    this.name = 'GithubReaderAdminError'
  }
}
interface VerifiedMapping {
  readonly appId: string
  readonly installationId: string
  readonly accountId: string
  readonly repositoryId: string
  readonly fullName: string
  readonly projectId: number
  readonly taskId: number
}
const sql = (text: string, ...params: unknown[]) => ({ text, params })
const id = (value: number) => Number.isSafeInteger(value) && value > 0
const decimal = (value: string) =>
  /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
const digest = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
export class NativeGithubReaderAdmin {
  constructor(private readonly database: InvoiceStateDatabase) {}
  async #atomic(statements: Parameters<typeof atomicStatements>[1]) {
    try {
      return await atomicStatements(this.database, statements)
    } catch (error) {
      const guard = statements[0]
      if (guard?.text.startsWith('INSERT INTO github_reader_admin_guards(')) {
        const [, commandId, bodyHash, userId, sessionId, now, connectionId, expectedGeneration] =
          guard.params
        try {
          const [facts] =
            (
              await atomicStatements(this.database, [
                sql(
                  `SELECT
            EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.is_active=1 AND u.profile='administrator' AND s.id=? AND s.profile_snapshot='administrator' AND s.revoked_at IS NULL AND julianday(s.idle_expires_at)>julianday(?) AND julianday(s.absolute_expires_at)>julianday(?) AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=u.id)) authorized,
            (SELECT body_hash FROM github_reader_admin_receipts WHERE command_id=?) receipt_hash,
            (SELECT actor_user_id FROM github_reader_admin_receipts WHERE command_id=?) receipt_actor,
            COALESCE((SELECT generation FROM github_read_connections WHERE id=?),0) generation`,
                  userId,
                  sessionId,
                  now,
                  now,
                  commandId,
                  commandId,
                  connectionId,
                ),
              ])
            )[0] ?? []
          if (facts?.authorized !== 1) throw new GithubReaderAdminError('forbidden')
          if (
            facts.receipt_hash !== null &&
            (facts.receipt_hash !== bodyHash || facts.receipt_actor !== userId)
          )
            throw new GithubReaderAdminError('command_reused')
          if (facts.receipt_hash === null && facts.generation !== expectedGeneration)
            throw new GithubReaderAdminError('conflict')
        } catch (checkError) {
          if (checkError instanceof GithubReaderAdminError) throw checkError
        }
      }
      throw error
    }
  }
  #validate(
    authority: GithubReaderAuthority,
    commandId: string,
    expectedGeneration: number,
    now: string,
  ) {
    if (
      !id(authority.userId) ||
      !id(authority.sessionId) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(commandId) ||
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 0 ||
      !Number.isFinite(Date.parse(now)) ||
      new Date(now).toISOString() !== now
    )
      throw new GithubReaderAdminError('invalid')
  }
  async status(authority: GithubReaderAuthority, now: string) {
    const result = await this.#atomic([
      sql(
        `SELECT
      EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.is_active=1 AND u.profile='administrator' AND s.id=? AND s.profile_snapshot='administrator' AND s.revoked_at IS NULL AND julianday(s.idle_expires_at)>julianday(?) AND julianday(s.absolute_expires_at)>julianday(?) AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=u.id)) authorized,
      (SELECT count(*) FROM github_read_connections) connection_count,
      (SELECT count(*) FROM github_read_resources) resource_count,
      COALESCE((SELECT json_group_array(json_object('id',c.id,'generation',c.generation,'installation_id',c.installation_id,'state',c.state,'deferred_until',c.cooldown,'failure_codes',json(COALESCE((SELECT json_group_array(failure_code) FROM (SELECT c.failure_code failure_code WHERE c.failure_code IS NOT NULL UNION SELECT failure_code FROM github_read_resources WHERE connection_id=c.id AND failure_code IS NOT NULL)),'[]')),'resources',json(COALESCE((SELECT json_group_array(json_object('repository_id',r.repository_id,'full_name',r.full_name,'project_id',r.project_id,'task_id',r.task_id,'state',r.state,'attempts',r.attempts,'next_retry_at',r.next_due,'failure_code',r.failure_code,'checkpoint_status',COALESCE((SELECT status FROM github_read_checkpoints cp WHERE cp.connection_id=c.id AND cp.repository_id=r.repository_id),'idle'),'items_visible',(SELECT count(*) FROM github_read_items i WHERE i.connection_id=c.id AND i.repository_id=r.repository_id AND json_extract(i.metadata,'$.status')='visible'),'items_unavailable',(SELECT count(*) FROM github_read_items i WHERE i.connection_id=c.id AND i.repository_id=r.repository_id AND json_extract(i.metadata,'$.status')='unavailable'))) FROM (SELECT * FROM github_read_resources WHERE connection_id=c.id ORDER BY repository_id LIMIT 1000) r),'[]')))) FROM (SELECT * FROM github_read_connections ORDER BY id LIMIT 100) c),'[]') connections`,
        authority.userId,
        authority.sessionId,
        now,
        now,
      ),
    ])
    const row = result[0]?.[0]
    if (row?.authorized !== 1) throw new GithubReaderAdminError('forbidden')
    if (Number(row.connection_count) > 100 || Number(row.resource_count) > 1000)
      throw new GithubReaderAdminError('conflict')
    return JSON.parse(String(row.connections)) as readonly {
      id: string
      generation: number
      installation_id: string
      state: 'active' | 'disconnecting' | 'disconnected' | 'revoked'
      resources: readonly {
        repository_id: string
        full_name: string | null
        project_id: number | null
        task_id: number | null
        state: 'active' | 'renamed' | 'transferred' | 'deleted' | 'access_lost'
        checkpoint_status: 'idle' | 'running' | 'complete'
        attempts: number
        next_retry_at: number
        failure_code: string | null
        items_visible: number
        items_unavailable: number
      }[]
      deferred_until: number | null
      failure_codes: readonly string[]
    }[]
  }
  async binding(
    connectionId: string,
    includeInactive = false,
  ): Promise<GithubReaderBinding | null> {
    const results = await this.#atomic([
      sql(
        `SELECT c.*,COALESCE((SELECT json_group_array(json_object('repositoryId',r.repository_id,'fullName',r.full_name)) FROM github_read_resources r WHERE r.connection_id=c.id AND r.project_id IS NOT NULL AND r.task_id IS NOT NULL AND r.full_name IS NOT NULL AND r.state IN ('active','renamed')),'[]') repositories FROM github_read_connections c WHERE id=?`,
        connectionId,
      ),
    ])
    const row = results[0]?.[0]
    if (!row || (!includeInactive && row.state !== 'active')) return null
    const [appId] = String(row.id).split(':')
    return {
      connectionId: String(row.id),
      generation: Number(row.generation),
      appId: appId!,
      installationId: String(row.installation_id),
      accountId: String(row.account_id),
      repositories: JSON.parse(String(row.repositories)) as GithubReaderBinding['repositories'],
    }
  }
  async installationBinding(
    appId: string,
    installationId: string,
  ): Promise<GithubReaderBinding | null> {
    if (![appId, installationId].every(decimal)) return null
    const result = await this.#atomic([
      sql(
        'SELECT id FROM github_read_connections WHERE installation_id=? AND id LIKE ? LIMIT 2',
        installationId,
        `${appId}:%`,
      ),
    ])
    const rows = result[0] ?? []
    return rows.length === 1 ? this.binding(String(rows[0]!.id), true) : null
  }
  async requestReconcile(authority: GithubReaderAuthority, now: string): Promise<void> {
    const commandId = crypto.randomUUID(),
      token = crypto.randomUUID()
    this.#validate(authority, commandId, 0, now)
    await this.#atomic([
      sql(
        'INSERT INTO github_reader_admin_guards(token,command_id,body_hash,actor_user_id,session_id,occurred_at,connection_id,expected_generation) VALUES(?,?,?,?,?,?,?,?)',
        token,
        commandId,
        '0'.repeat(64),
        authority.userId,
        authority.sessionId,
        now,
        'reconcile',
        0,
      ),
      sql(
        "UPDATE github_read_resources SET attempts=0,next_due=?,failure_code=NULL WHERE connection_id IN (SELECT id FROM github_read_connections WHERE state='active') AND lease_token IS NULL",
        Date.parse(now),
      ),
      sql('DELETE FROM github_reader_admin_guards WHERE token=?', token),
    ])
  }
  async linkedItem(actor: { userId: number; profile: string }, linkId: number) {
    const rows = await this.#atomic([
      sql(
        `SELECT l.*,COALESCE(l.project_id,t.project_id) target_project_id FROM work_item_links l
       JOIN work_item_connections c ON c.id=l.connection_id LEFT JOIN time_entries t ON t.id=l.time_entry_id
       WHERE l.id=? AND c.provider='github' AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.is_active=1 AND NOT EXISTS(SELECT 1 FROM account_closures x WHERE x.user_id=u.id))
       AND ((?='administrator' AND EXISTS(SELECT 1 FROM users admin WHERE admin.id=? AND admin.profile='administrator')) OR (t.user_id=? AND EXISTS(SELECT 1 FROM user_assignments a WHERE a.user_id=? AND a.project_id=t.project_id AND a.is_active=1)))`,
        linkId,
        actor.userId,
        actor.profile,
        actor.userId,
        actor.userId,
        actor.userId,
      ),
    ])
    const link = rows[0]?.[0]
    if (!link) return null
    const reference =
      parseGithubIssueReference(String(link.provider_item_id)) ??
      (link.url === null ? null : parseGithubIssueReference(String(link.url)))
    if (!reference) return { status: 'unverified' as const, item: null }
    const result = await this.#atomic([
      sql(
        `SELECT i.metadata,c.state connection_state,r.state resource_state FROM github_read_aliases a
       JOIN github_read_items i ON i.connection_id=a.connection_id AND i.issue_id=a.issue_id
       JOIN github_read_connections c ON c.id=i.connection_id JOIN github_read_resources r ON r.connection_id=i.connection_id AND r.repository_id=i.repository_id
       WHERE a.alias=? AND c.work_item_connection_id=? AND r.project_id=? LIMIT 2`,
        reference.alias,
        link.connection_id,
        link.target_project_id,
      ),
    ])
    const matches = result[0] ?? []
    if (matches.length !== 1) return { status: 'unverified' as const, item: null }
    const row = matches[0]!,
      item = JSON.parse(String(row.metadata)) as {
        issueId: string
        canonicalUrl: string
        title: string
        state: 'open' | 'closed'
        remoteUpdatedAt: string
        status: string
      }
    const visible =
      item.status === 'visible' &&
      row.connection_state === 'active' &&
      ['active', 'renamed'].includes(String(row.resource_state))
    return {
      status: visible ? ('verified' as const) : ('unavailable' as const),
      item: {
        id: item.issueId,
        url: item.canonicalUrl,
        title: item.title,
        state: item.state,
        updated_at: item.remoteUpdatedAt,
      },
    }
  }
  async map(
    authority: GithubReaderAuthority,
    input: { commandId: string; expectedGeneration: number; verified: VerifiedMapping },
    now: string,
  ): Promise<{ connectionId: string; generation: number }> {
    this.#validate(authority, input.commandId, input.expectedGeneration, now)
    const v = input.verified
    if (
      ![v.appId, v.installationId, v.accountId, v.repositoryId].every(decimal) ||
      !id(v.projectId) ||
      !id(v.taskId) ||
      !/^[-A-Za-z0-9]+\/[A-Za-z0-9._-]+$/.test(v.fullName) ||
      v.fullName.length > 140
    )
      throw new GithubReaderAdminError('invalid')
    const connectionId = `${v.appId}:${v.installationId}:${v.accountId}`
    const bodyHash = await digest([
      'map',
      connectionId,
      v.repositoryId,
      v.projectId,
      v.taskId,
      input.expectedGeneration,
    ])
    const token = crypto.randomUUID()
    const fresh = `NOT EXISTS(SELECT 1 FROM github_reader_admin_receipts WHERE command_id=?)`
    const result = await this.#atomic([
      sql(
        'INSERT INTO github_reader_admin_guards(token,command_id,body_hash,actor_user_id,session_id,occurred_at,connection_id,expected_generation) VALUES(?,?,?,?,?,?,?,?) RETURNING token',
        token,
        input.commandId,
        bodyHash,
        authority.userId,
        authority.sessionId,
        now,
        connectionId,
        input.expectedGeneration,
      ),
      sql(
        `INSERT INTO github_read_connections(id,installation_id,account_id,owner_user_id,verified_at)
        SELECT ?,?,?,?,? WHERE ${fresh} AND EXISTS(SELECT 1 FROM projects p JOIN task_assignments a ON a.project_id=p.id JOIN tasks t ON t.id=a.task_id WHERE p.id=? AND t.id=? AND p.is_active=1 AND t.is_active=1 AND a.is_active=1)
        ON CONFLICT(id) DO UPDATE SET state='active',generation=generation+1,owner_user_id=excluded.owner_user_id,verified_at=excluded.verified_at,cooldown=NULL,failure_code=NULL RETURNING generation`,
        connectionId,
        v.installationId,
        v.accountId,
        authority.userId,
        now,
        input.commandId,
        v.projectId,
        v.taskId,
      ),
      sql(
        `INSERT INTO github_read_resources(connection_id,repository_id,full_name,project_id,task_id,state)
        SELECT ?,?,?,?,?,'active' WHERE ${fresh} AND changes()=1
        ON CONFLICT(connection_id,repository_id) DO UPDATE SET full_name=excluded.full_name,project_id=excluded.project_id,task_id=excluded.task_id,state='active' RETURNING repository_id`,
        connectionId,
        v.repositoryId,
        v.fullName,
        v.projectId,
        v.taskId,
        input.commandId,
      ),
      sql(
        `INSERT INTO github_reader_admin_receipts(command_id,body_hash,actor_user_id,operation,connection_id,accepted_generation,occurred_at)
        SELECT ?,?,?,'map',id,generation,? FROM github_read_connections WHERE id=? AND ${fresh} AND changes()=1 RETURNING accepted_generation`,
        input.commandId,
        bodyHash,
        authority.userId,
        now,
        connectionId,
        input.commandId,
      ),
      sql(
        'SELECT accepted_generation FROM github_reader_admin_receipts WHERE command_id=? AND body_hash=? AND actor_user_id=?',
        input.commandId,
        bodyHash,
        authority.userId,
      ),
      sql('DELETE FROM github_reader_admin_guards WHERE token=? RETURNING token', token),
    ])
    const receipt = result[4]?.[0]
    if (!receipt) throw new GithubReaderAdminError('conflict')
    return { connectionId, generation: Number(receipt.accepted_generation) }
  }
  async disconnect(
    authority: GithubReaderAuthority,
    input: { commandId: string; connectionId: string; expectedGeneration: number },
    now: string,
  ): Promise<{ generation: number }> {
    this.#validate(authority, input.commandId, input.expectedGeneration, now)
    const bodyHash = await digest(['disconnect', input.connectionId, input.expectedGeneration])
    const token = crypto.randomUUID()
    const result = await this.#atomic([
      sql(
        'INSERT INTO github_reader_admin_guards(token,command_id,body_hash,actor_user_id,session_id,occurred_at,connection_id,expected_generation) VALUES(?,?,?,?,?,?,?,?) RETURNING token',
        token,
        input.commandId,
        bodyHash,
        authority.userId,
        authority.sessionId,
        now,
        input.connectionId,
        input.expectedGeneration,
      ),
      sql(
        `UPDATE github_read_connections SET state='disconnected',generation=generation+1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM github_reader_admin_receipts WHERE command_id=?) RETURNING generation`,
        input.connectionId,
        input.commandId,
      ),
      sql(
        `INSERT INTO github_reader_admin_receipts(command_id,body_hash,actor_user_id,operation,connection_id,accepted_generation,occurred_at) SELECT ?,?,?,'disconnect',id,generation,? FROM github_read_connections WHERE id=? AND changes()=1 RETURNING accepted_generation`,
        input.commandId,
        bodyHash,
        authority.userId,
        now,
        input.connectionId,
      ),
      sql(
        'SELECT accepted_generation FROM github_reader_admin_receipts WHERE command_id=? AND body_hash=? AND actor_user_id=?',
        input.commandId,
        bodyHash,
        authority.userId,
      ),
      sql('DELETE FROM github_reader_admin_guards WHERE token=? RETURNING token', token),
    ])
    const receipt = result[3]?.[0]
    if (!receipt) throw new GithubReaderAdminError('conflict')
    return { generation: Number(receipt.accepted_generation) }
  }
}
