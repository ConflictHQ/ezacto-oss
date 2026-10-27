import {
  createGithubCommentSurface,
  CooldownError,
  AmbiguousWriteError,
  GithubPublicationError,
  GithubReadError,
  GithubHttpError,
  parseGithubIssueReference,
  reconcilePublication,
  renderTimeComment,
  type GithubPublicationAuthority,
  type GithubPublicationPort,
  type GithubPublicationPreview,
  type GithubPublicationRow,
} from '@ezacto/integrations'
import { atomicStatements } from './atomic-statements.js'
import { NativeGithubPublicationJournal } from './github-publication-journal.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import type { GithubReaderServiceOptions } from './github-reader-service.js'
// Native atomicStatements consumes row-returning statements on both runtimes.
const sql = (text: string, ...params: unknown[]) => ({
  text:
    /^(INSERT|UPDATE|DELETE)\b/.test(text) && !/\bRETURNING\b/i.test(text)
      ? `${text} RETURNING *`
      : text,
  params,
})
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
const validId = (n: number) => Number.isSafeInteger(n) && n > 0
const assertion = (condition: string, ...params: unknown[]) =>
  sql(
    `INSERT INTO github_publication_assertions(token,ok) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`,
    crypto.randomUUID(),
    ...params,
  )
const command = (s: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s)

export function createGithubPublicationService(
  database: InvoiceStateDatabase,
  options: GithubReaderServiceOptions,
) {
  const now = () => options.now().getTime()
  async function authorized(authority: GithubPublicationAuthority) {
    await transaction(authority, [])
  }
  async function transaction(
    authority: GithubPublicationAuthority,
    statements: ReturnType<typeof sql>[],
  ) {
    const token = crypto.randomUUID()
    try {
      return (
        await atomicStatements(database, [
          sql(
            'INSERT INTO github_publication_guards(token,actor,session_id,now,administrator) VALUES(?,?,?,?,1)',
            token,
            authority.userId,
            authority.sessionId,
            options.now().toISOString(),
          ),
          ...statements,
          sql('DELETE FROM github_publication_guards WHERE token=?', token),
          sql('DELETE FROM github_publication_assertions'),
        ])
      ).slice(1, -1)
    } catch (error) {
      // Do not discard unknown storage failures: callers retain their diagnostic cause.
      if (
        error instanceof Error &&
        /github_publication_assertions|CHECK constraint failed: ok/.test(error.message)
      )
        throw new GithubPublicationError('conflict')
      if (error instanceof Error && /github_publication_forbidden/.test(error.message))
        throw new GithubPublicationError('forbidden')
      throw error
    }
  }
  async function receipt(authority: GithubPublicationAuthority, commandId: string, input: unknown) {
    if (!command(commandId)) throw new GithubPublicationError('invalid')
    const digest = await hash(input)
    const [rows] = await transaction(authority, [
      sql(
        'SELECT body_hash,actor_user_id FROM github_publication_receipts WHERE command_id=?',
        commandId,
      ),
    ])
    if (rows?.[0]) {
      if (rows[0].body_hash !== digest || rows[0].actor_user_id !== authority.userId)
        throw new GithubPublicationError('conflict')
      return { digest, replay: true }
    }
    return { digest, replay: false }
  }
  const audit = (
    authority: GithubPublicationAuthority,
    commandId: string,
    digest: string,
    operation: string,
    connection: string,
    id: number | null = null,
  ) =>
    sql(
      'INSERT INTO github_publication_receipts(command_id,body_hash,actor_user_id,operation,connection_id,publication_id,occurred_at) VALUES(?,?,?,?,?,?,?)',
      commandId,
      digest,
      authority.userId,
      operation,
      connection,
      id,
      options.now().toISOString(),
    )
  async function binding(connectionId: string) {
    const [rows] = await atomicStatements(database, [
      sql(
        `SELECT c.*,p.marker,p.generation policy_generation,p.enabled,p.verified_at publication_verified_at FROM github_read_connections c LEFT JOIN github_publication_policy p ON p.connection_id=c.id WHERE c.id=?`,
        connectionId,
      ),
    ])
    const row = rows?.[0]
    if (!row || row.state !== 'active') throw new GithubPublicationError('conflict')
    return row
  }
  async function surface(
    connection: Record<string, unknown>,
    repository: string,
    beforeWrite: () => Promise<boolean>,
    issueId?: string,
  ) {
    const credentials = await options.credentials()
    if (!credentials || !String(connection.id).startsWith(`${credentials.appId}:`))
      throw new GithubPublicationError('unavailable')
    return createGithubCommentSurface({
      ...credentials,
      installationId: String(connection.installation_id),
      repositoryId: repository,
      accountId: String(connection.account_id),
      fetch: options.fetch,
      now,
      beforeWrite,
      ...(issueId ? { issueId } : {}),
    })
  }
  async function readPreview(
    authority: GithubPublicationAuthority,
    linkId: number,
  ): Promise<
    GithubPublicationPreview & {
      snapshot: Record<string, unknown>
      prior: Record<string, unknown>[]
    }
  > {
    if (!validId(linkId)) throw new GithubPublicationError('invalid')
    const [rows] = await transaction(authority, [
      sql(
        `SELECT l.id link_id,l.provider_item_id,l.url,l.updated_at link_updated,t.id entry_id,t.user_id subject_user_id,(SELECT created_at FROM users WHERE id=t.user_id) subject_created_at,t.spent_date,t.seconds,t.updated_at entry_updated,t.project_id,c.id connection_id,c.generation connection_generation,p.generation policy_generation,CASE WHEN p.instance_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1) THEN p.enabled ELSE 0 END policy_enabled
      FROM work_item_links l JOIN time_entries t ON t.id=l.time_entry_id JOIN github_read_connections c ON c.work_item_connection_id=l.connection_id AND c.state='active'
      LEFT JOIN github_publication_policy p ON p.connection_id=c.id WHERE l.id=? AND t.seconds>0 AND EXISTS(SELECT 1 FROM users u WHERE u.id=t.user_id AND u.is_active=1) AND NOT EXISTS(SELECT 1 FROM account_closures a WHERE a.user_id=t.user_id)`,
        linkId,
      ),
    ])
    if (rows?.length !== 1) throw new GithubPublicationError('conflict')
    const row = rows[0]!
    const reference =
      parseGithubIssueReference(String(row.provider_item_id)) ??
      parseGithubIssueReference(String(row.url))
    if (!reference) throw new GithubPublicationError('conflict')
    const [items] = await transaction(authority, [
      sql(
        `SELECT i.metadata,i.repository_id,i.issue_id,r.project_id resource_project,r.state resource_state FROM github_read_aliases a JOIN github_read_items i ON i.connection_id=a.connection_id AND i.issue_id=a.issue_id JOIN github_read_resources r ON r.connection_id=i.connection_id AND r.repository_id=i.repository_id
      WHERE a.connection_id=? AND a.alias=? AND r.project_id=? AND r.state IN ('active','renamed') AND json_extract(i.metadata,'$.status')='visible'`,
        row.connection_id,
        reference.alias,
        row.project_id,
      ),
    ])
    if (items?.length !== 1) throw new GithubPublicationError('conflict')
    const item = JSON.parse(String(items[0]!.metadata)) as { canonicalUrl: string }
    const [priorRows] = await transaction(authority, [
      sql(
        `SELECT * FROM github_publications WHERE connection_id=? AND entry_id=? AND issue_id=? AND consent_nonce<>(SELECT nonce FROM github_publication_instance WHERE singleton=1) AND status<>'unlinked' ORDER BY id DESC LIMIT 17`,
        row.connection_id,
        row.entry_id,
        items[0]!.issue_id,
      ),
    ])
    if (priorRows!.length > 16) throw new GithubPublicationError('conflict')
    const prior = priorRows!
    return {
      link_id: linkId,
      connection_id: String(row.connection_id),
      destination: item.canonicalUrl,
      spent_date: String(row.spent_date),
      seconds: Number(row.seconds),
      source_version: await hash({
        ...row,
        repository_id: items[0]!.repository_id,
        issue_id: items[0]!.issue_id,
        destination: item.canonicalUrl,
        resource_state: items[0]!.resource_state,
        prior,
      }),
      policy_enabled: row.policy_enabled === 1,
      snapshot: { ...row, ...items[0]! },
      prior,
    }
  }
  async function priorReceipt(proposed: Awaited<ReturnType<typeof readPreview>>) {
    const existing = proposed.prior
    if (!existing.length) return null
    if (
      existing.some(
        (r) =>
          r.subject_user_id !== proposed.snapshot.subject_user_id ||
          r.subject_created_at !== proposed.snapshot.subject_created_at ||
          String(r.repository_id) !== String(proposed.snapshot.repository_id),
      )
    )
      throw new GithubPublicationError('conflict')
    const knownIds = new Set(
      existing.filter((r) => r.remote_id !== null).map((r) => String(r.remote_id)),
    )
    if (knownIds.size > 1) throw new GithubPublicationError('conflict')
    const latest = existing[0]!,
      connection = await binding(proposed.connection_id)
    const api = await surface(
      connection,
      String(latest.repository_id),
      async () => false,
      String(latest.issue_id),
    )
    const prefix = (row: Record<string, unknown>) =>
      `<!-- ezacto-time:${row.marker}:${row.entry_id} -->`
    let matched: Record<string, unknown>,
      remote: Awaited<ReturnType<typeof api.getComment>> = null
    if (knownIds.size) {
      matched = existing.find((r) => r.remote_id !== null)!
      remote = await api.getComment(String(matched.issue_number), String(matched.remote_id))
      if (!remote) {
        const pending =
          matched.pending_write === null
            ? null
            : (JSON.parse(String(matched.pending_write)) as { kind: string })
        if (pending?.kind !== 'delete') throw new GithubPublicationError('conflict')
        return null
      }
    } else {
      // A snapshot can precede the durable attempt while the old instance later
      // sends it. Even an apparently untouched pending row must be reconciled.
      const listing = await api.listComments(String(latest.issue_number))
      const matches = listing.comments.filter(
        (c) => c.authorId === api.appAuthorId && existing.some((r) => c.body.startsWith(prefix(r))),
      )
      if (matches.length > 1) throw new GithubPublicationError('conflict')
      remote = matches[0] ?? null
      if (!remote) {
        const lastAdmission = Math.max(
          Date.parse(String(connection.publication_verified_at)),
          ...existing.map((r) => Number(r.attempted_at ?? 0)),
        )
        if (!listing.complete || !Number.isFinite(lastAdmission) || now() - lastAdmission < 60000)
          throw new GithubPublicationError('conflict')
        return null
      }
      matched = existing.find((r) => remote!.body.startsWith(prefix(r)))!
    }
    const pending =
      matched.pending_write === null
        ? null
        : (JSON.parse(String(matched.pending_write)) as { kind: string; body?: string })
    const intended =
      matched.last_body ??
      (matched.desired_date !== null && matched.desired_seconds !== null
        ? renderTimeComment(String(matched.marker), String(matched.entry_id), {
            spentDate: String(matched.desired_date),
            seconds: Number(matched.desired_seconds),
          })
        : null)
    if (
      remote.authorId !== api.appAuthorId ||
      !remote.body.startsWith(prefix(matched)) ||
      (remote.body !== intended && !(pending?.kind === 'update' && remote.body === pending.body))
    )
      throw new GithubPublicationError('conflict')
    return {
      id: remote.id,
      body: remote.body,
      marker: String(matched.marker),
      date: matched.last_date,
      seconds: matched.last_seconds,
    }
  }
  const port: GithubPublicationPort & { tick(): Promise<void> } = {
    async list(authority) {
      const result = await transaction(authority, [
        sql(
          'SELECT connection_id,CASE WHEN instance_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1) THEN enabled ELSE 0 END enabled,generation FROM github_publication_policy ORDER BY connection_id LIMIT 100',
        ),
        sql(
          `SELECT id,connection_id,entry_id,destination,desired_date spent_date,desired_seconds seconds,CASE WHEN status='unlinked' THEN 'unlinked' WHEN consent_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1) THEN status ELSE 'prior_instance' END status,source_version,source_version version,remote_id,failure_code,retry_at next_retry_at FROM github_publications ORDER BY CASE WHEN status IN ('unlinked','retired') THEN 1 ELSE 0 END,id DESC LIMIT 100`,
        ),
        sql(
          `SELECT l.id link_id,l.time_entry_id entry_id FROM work_item_links l JOIN work_item_connections c ON c.id=l.connection_id JOIN time_entries t ON t.id=l.time_entry_id WHERE c.provider='github' AND c.status='active' AND t.seconds>0 ORDER BY l.id DESC LIMIT 100`,
        ),
      ])
      return {
        policies: result[0]!.map((r) => ({
          connection_id: String(r.connection_id),
          enabled: r.enabled === 1,
          generation: Number(r.generation),
        })),
        publications: result[1] as unknown as GithubPublicationRow[],
        candidates: result[2] as unknown as { link_id: number; entry_id: number }[],
      }
    },
    async preview(authority, linkId) {
      const result = await readPreview(authority, linkId)
      return {
        link_id: result.link_id,
        connection_id: result.connection_id,
        destination: result.destination,
        spent_date: result.spent_date,
        seconds: result.seconds,
        source_version: result.source_version,
        policy_enabled: result.policy_enabled,
      }
    },
    async policy(authority, input) {
      await authorized(authority)
      if (
        !Number.isSafeInteger(input.expected_generation) ||
        input.expected_generation < 0 ||
        (input.enabled && !input.confirm_permission)
      )
        throw new GithubPublicationError('invalid')
      const checked = await receipt(authority, input.command_id, input)
      if (checked.replay) return
      const connection = await binding(input.connection_id)
      if (Number(connection.policy_generation ?? 0) !== input.expected_generation)
        throw new GithubPublicationError('conflict')
      if (input.enabled) {
        const [rows] = await transaction(authority, [
          sql(
            `SELECT repository_id FROM github_read_resources WHERE connection_id=? AND state IN ('active','renamed') ORDER BY repository_id LIMIT 1`,
            input.connection_id,
          ),
        ])
        if (!rows?.[0]) throw new GithubPublicationError('conflict')
        await surface(connection, String(rows[0].repository_id), async () => false)
      }
      await transaction(authority, [
        sql(
          `INSERT INTO github_publication_policy(connection_id,enabled,generation,marker,verified_app_id,verified_at,instance_nonce)
        SELECT id,?,1,?,?,?,(SELECT nonce FROM github_publication_instance WHERE singleton=1) FROM github_read_connections WHERE id=? AND state='active' AND generation=?
        ON CONFLICT(connection_id) DO UPDATE SET marker=CASE WHEN github_publication_policy.instance_nonce<>excluded.instance_nonce THEN excluded.marker ELSE github_publication_policy.marker END,enabled=excluded.enabled,generation=github_publication_policy.generation+1,verified_at=excluded.verified_at,instance_nonce=excluded.instance_nonce WHERE github_publication_policy.generation=?`,
          input.enabled ? 1 : 0,
          await hash(crypto.randomUUID()),
          String(connection.id).split(':')[0],
          options.now().toISOString(),
          input.connection_id,
          connection.generation,
          input.expected_generation,
        ),
        assertion('changes()=1'),
        audit(authority, input.command_id, checked.digest, 'policy', input.connection_id),
      ])
    },
    async consent(authority, input) {
      const checked = await receipt(authority, input.command_id, input)
      if (checked.replay) return
      const proposed = await readPreview(authority, input.link_id)
      if (!proposed.policy_enabled || proposed.source_version !== input.source_version)
        throw new GithubPublicationError('conflict')
      const reference = parseGithubIssueReference(proposed.destination)!
      const inherited = await priorReceipt(proposed)
      await transaction(authority, [
        ...proposed.prior.map((row) =>
          assertion(
            'EXISTS(SELECT 1 FROM github_publications WHERE id=? AND source_version=? AND status=? AND remote_id IS ? AND last_body IS ? AND attempted_at IS ? AND pending_write IS ? AND fence=?)',
            row.id,
            row.source_version,
            row.status,
            row.remote_id,
            row.last_body,
            row.attempted_at,
            row.pending_write,
            row.fence,
          ),
        ),
        sql(
          `INSERT INTO github_publications(connection_id,entry_id,subject_user_id,subject_created_at,consent_nonce,marker,link_id,repository_id,issue_id,issue_number,destination,desired_date,desired_seconds,remote_id,last_body,last_date,last_seconds)
        SELECT c.id,t.id,t.user_id,(SELECT created_at FROM users WHERE id=t.user_id),(SELECT nonce FROM github_publication_instance WHERE singleton=1),COALESCE(?,p.marker),l.id,i.repository_id,i.issue_id,json_extract(i.metadata,'$.number'),json_extract(i.metadata,'$.canonicalUrl'),t.spent_date,t.seconds,?,?,?,?
        FROM work_item_links l JOIN time_entries t ON t.id=l.time_entry_id JOIN github_read_connections c ON c.work_item_connection_id=l.connection_id
        JOIN github_read_aliases a ON a.connection_id=c.id AND a.alias=? JOIN github_read_items i ON i.connection_id=a.connection_id AND i.issue_id=a.issue_id
        JOIN github_read_resources r ON r.connection_id=c.id AND r.repository_id=i.repository_id
        JOIN github_publication_policy p ON p.connection_id=c.id AND p.enabled=1 AND p.instance_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1)
        WHERE l.id=? AND c.id=? AND c.state='active' AND EXISTS(SELECT 1 FROM users u WHERE u.id=t.user_id AND u.is_active=1) AND NOT EXISTS(SELECT 1 FROM account_closures a WHERE a.user_id=t.user_id) AND t.user_id=? AND (SELECT created_at FROM users WHERE id=t.user_id)=? AND t.spent_date=? AND t.seconds=? AND t.updated_at=? AND l.updated_at=? AND t.project_id=? AND c.generation=? AND p.generation=? AND i.repository_id=? AND i.issue_id=? AND json_extract(i.metadata,'$.canonicalUrl')=? AND json_extract(i.metadata,'$.status')='visible' AND r.project_id=t.project_id AND r.state=?
        ON CONFLICT(connection_id,entry_id,issue_id,consent_nonce,subject_user_id,subject_created_at) DO UPDATE SET link_id=excluded.link_id,desired_date=excluded.desired_date,desired_seconds=excluded.desired_seconds,source_version=github_publications.source_version+1,status=CASE WHEN github_publications.status='unlinked' THEN 'pending' ELSE github_publications.status END,next_due=0`,
          inherited?.marker ?? null,
          inherited?.id ?? null,
          inherited?.body ?? null,
          inherited?.date ?? null,
          inherited?.seconds ?? null,
          reference.alias,
          input.link_id,
          proposed.connection_id,
          proposed.snapshot.subject_user_id,
          proposed.snapshot.subject_created_at,
          proposed.spent_date,
          proposed.seconds,
          proposed.snapshot.entry_updated,
          proposed.snapshot.link_updated,
          proposed.snapshot.project_id,
          proposed.snapshot.connection_generation,
          proposed.snapshot.policy_generation,
          proposed.snapshot.repository_id,
          proposed.snapshot.issue_id,
          proposed.destination,
          proposed.snapshot.resource_state,
        ),
        assertion('changes()=1'),
        audit(authority, input.command_id, checked.digest, 'consent', proposed.connection_id),
      ])
    },
    async act(authority, input) {
      if (!validId(input.id) || !validId(input.expected_version) || !input.confirm)
        throw new GithubPublicationError('invalid')
      const checked = await receipt(authority, input.command_id, input)
      if (checked.replay) return
      const [rows] = await transaction(authority, [
        sql(
          'SELECT * FROM github_publications WHERE id=? AND source_version=? AND (lease_until IS NULL OR lease_until<=?)',
          input.id,
          input.expected_version,
          now(),
        ),
      ])
      const row = rows?.[0]
      if (!row) throw new GithubPublicationError('conflict')
      if (input.action === 'unlink') {
        await transaction(authority, [
          sql(
            "UPDATE github_publications SET status='unlinked',link_id=NULL,source_version=source_version+1 WHERE id=? AND source_version=? AND (lease_until IS NULL OR lease_until<=?)",
            input.id,
            input.expected_version,
            now(),
          ),
          assertion('changes()=1'),
          audit(
            authority,
            input.command_id,
            checked.digest,
            'unlink',
            String(row.connection_id),
            input.id,
          ),
        ])
        return
      }
      const [currentNonce] = await transaction(authority, [
        sql('SELECT nonce FROM github_publication_instance WHERE singleton=1'),
      ])
      if (row.consent_nonce !== currentNonce?.[0]?.nonce)
        throw new GithubPublicationError('conflict')
      if (!['retry', 'adopt', 'restore'].includes(input.action))
        throw new GithubPublicationError('invalid')
      const connection = await binding(String(row.connection_id))
      let remoteBody: string | null = null
      let restoreRemoved = false
      if (input.action === 'adopt' || input.action === 'restore') {
        if (row.status !== 'conflicted' || row.remote_id === null)
          throw new GithubPublicationError('conflict')
        const api = await surface(
          connection,
          String(row.repository_id),
          async () => false,
          String(row.issue_id),
        )
        const remote = await api.getComment(String(row.issue_number), String(row.remote_id))
        if (!remote && input.action === 'restore') restoreRemoved = true
        else if (
          !remote ||
          remote.authorId !== api.appAuthorId ||
          !remote.body.startsWith(`<!-- ezacto-time:${row.marker}:${row.entry_id} -->`)
        )
          throw new GithubPublicationError('conflict')
        remoteBody = remote?.body ?? null
      }
      await transaction(authority, [
        sql(
          `UPDATE github_publications SET status=?,last_body=CASE WHEN ? THEN NULL ELSE COALESCE(?,last_body) END,remote_id=CASE WHEN ? THEN NULL ELSE remote_id END,attempted_at=CASE WHEN ? THEN NULL ELSE attempted_at END,create_attempts=0,next_due=0,retry_at=NULL,failure_code=NULL,source_version=source_version+1
        WHERE id=? AND source_version=? AND (lease_until IS NULL OR lease_until<=?)`,
          input.action === 'adopt' ? 'adopted' : 'pending',
          restoreRemoved ? 1 : 0,
          remoteBody,
          restoreRemoved ? 1 : 0,
          restoreRemoved ? 1 : 0,
          input.id,
          input.expected_version,
          now(),
        ),
        assertion('changes()=1'),
        audit(
          authority,
          input.command_id,
          checked.digest,
          input.action,
          String(row.connection_id),
          input.id,
        ),
      ])
    },
    async tick() {
      const dispatch = crypto.randomUUID()
      const [claimed] = await atomicStatements(database, [
        sql(
          'UPDATE github_publication_dispatch SET token=?,expires_at=? WHERE id=1 AND expires_at<=? AND cooldown_until<=? RETURNING id',
          dispatch,
          now() + 120000,
          now(),
          now(),
        ),
      ])
      if (!claimed?.length) return
      try {
        await runTick(dispatch)
      } finally {
        await atomicStatements(database, [
          sql(
            'UPDATE github_publication_dispatch SET token=NULL,expires_at=0 WHERE id=1 AND token=?',
            dispatch,
          ),
        ])
      }
    },
  }
  async function runTick(dispatch: string) {
    const [rows] = await atomicStatements(database, [
      sql(
        `SELECT p.*,policy.generation policy_generation,c.generation connection_generation FROM github_publications p
        JOIN github_publication_policy policy ON policy.connection_id=p.connection_id AND policy.enabled=1 AND policy.instance_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1) JOIN github_read_connections c ON c.id=p.connection_id AND c.state='active'
        WHERE p.consent_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1) AND p.status NOT IN ('failed','conflicted','adopted','unlinked') AND p.next_due<=? AND (p.lease_until IS NULL OR p.lease_until<=?)
        AND NOT EXISTS(SELECT 1 FROM github_publications old WHERE old.entry_id=p.entry_id AND old.id<>p.id AND old.consent_nonce=p.consent_nonce AND p.desired_date IS NOT NULL AND old.status NOT IN ('retired','unlinked') AND (old.remote_id IS NOT NULL OR old.attempted_at IS NOT NULL))
        AND (p.retry_at IS NULL OR p.retry_at<=?) AND NOT (p.status='retired' AND p.desired_date IS NULL)
        ORDER BY CASE WHEN p.desired_date IS NULL THEN 0 ELSE 1 END,p.next_due,p.id LIMIT 1`,
        now(),
        now(),
        now(),
      ),
    ])
    const row = rows?.[0]
    if (!row) return
    const journal = new NativeGithubPublicationJournal(database, Number(row.id), now)
    let fence = 0
    const wrapped = {
      claim: async (...args: Parameters<typeof journal.claim>) => {
        const value = await journal.claim(...args)
        fence = value?.fence ?? 0
        return value
      },
      save: journal.save.bind(journal),
      release: journal.release.bind(journal),
    }
    try {
      const connection = await binding(String(row.connection_id))
      const api = await surface(
        connection,
        String(row.repository_id),
        async () => {
          const [lease] = await atomicStatements(database, [
            sql(
              'SELECT id FROM github_publication_dispatch WHERE id=1 AND token=? AND expires_at>?',
              dispatch,
              now() + 10000,
            ),
          ])
          return (
            lease?.length === 1 &&
            journal.permit(
              fence,
              Number(row.source_version),
              Number(row.connection_generation),
              Number(row.policy_generation),
            )
          )
        },
        String(row.issue_id),
      )
      const result = await reconcilePublication(
        { surface: api, journal: wrapped, marker: String(row.marker), now, settleMs: 60000 },
        {
          connectionId: String(row.connection_id),
          entryId: String(row.entry_id),
          itemId: String(row.issue_number),
        },
        Number(row.source_version),
        row.desired_date === null
          ? null
          : { spentDate: String(row.desired_date), seconds: Number(row.desired_seconds) },
      )
      await atomicStatements(database, [
        sql(
          'UPDATE github_publication_dispatch SET cooldown_until=max(cooldown_until,COALESCE((SELECT retry_at FROM github_publications WHERE id=? AND fence=?),0)) WHERE id=1 AND token=?',
          Number(row.id),
          fence,
          dispatch,
        ),
        sql(
          'UPDATE github_publications SET next_due=max(?,COALESCE(retry_at,0)),failure_code=? WHERE id=? AND fence=?',
          now() + 60000,
          result.code,
          Number(row.id),
          fence,
        ),
      ])
    } catch (error) {
      if (error instanceof CooldownError) {
        const until = now() + Math.min(Math.max(error.retryAfterMs, 1000), 86400000)
        await atomicStatements(database, [
          sql(
            'UPDATE github_publication_dispatch SET cooldown_until=max(cooldown_until,?) WHERE id=1',
            until,
          ),
          sql(
            "UPDATE github_publications SET status='deferred',retry_at=?,next_due=?,failure_code='cooldown' WHERE id=?",
            until,
            until,
            Number(row.id),
          ),
        ])
        return
      }
      const code =
        error instanceof GithubReadError || error instanceof AmbiguousWriteError
          ? 'provider_unavailable'
          : error instanceof GithubHttpError
            ? 'provider_unavailable'
            : error instanceof GithubPublicationError
              ? error.code
              : null
      if (code === null) throw error
      await atomicStatements(database, [
        sql(
          'UPDATE github_publications SET next_due=?,failure_code=? WHERE id=?',
          now() + 60000,
          code,
          Number(row.id),
        ),
      ])
    }
  }
  return port
}
