import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  parseAccountRetentionPolicy,
  type AccountRetentionCategory,
  type AccountClosureInventoryItem,
  type AccountClosureRecord,
  type AccountClosurePreview,
  type AccountClosureStore,
  AccountClosureError,
} from '@ezacto/core'
import type * as schema from './schema.js'
import { closedAccountProviderKey, accountClosureDigest } from './account-closure-sign-in.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type Native = BetterSqlite3.Database | D1Database
const isD1 = (client: Native): client is D1Database => 'batch' in client
const all = async <T>(client: Native, query: string, bindings: unknown[] = []): Promise<T[]> =>
  isD1(client)
    ? (
        await client
          .prepare(query)
          .bind(...bindings)
          .all<T>()
      ).results
    : (client.prepare(query).all(...bindings) as T[])
const identifier = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Unexpected database identifier')
  return `"${name}"`
}
const removedTables = new Set([
  'users',
  'user_emails',
  'user_identities',
  'user_passwords',
  'sessions',
  'api_tokens',
  'auth_tokens',
  'staff_magic_links',
  'oidc_app_codes',
  'two_factor_challenges',
  'user_totp_enrolments',
  'user_recovery_codes',
  'user_email_second_factors',
  'two_factor_email_code_sends',
  'notification_preferences',
  'user_roles',
  'user_departments',
  'teammate_assignments',
  'saved_report_pins',
  'saved_report_shares',
  'saved_report_role_shares',
  'saved_reports',
  'quickbooks_oauth_states',
  'quickbooks_managed_grants',
  'calendar_proposals',
  'calendar_connections',
  'planning_calendar_feeds',
  'allocations',
  'placeholder_assignment_keys',
  'time_off',
])
const closureTables = new Set([
  'organization_owner',
  'account_deletion_requests',
  'account_deletion_request_updates',
  // Capturing cleanup obligations must not invalidate the closure preview.
  'apple_web_cleanup_requests',
  'account_closures',
  'closed_account_sign_in_guards',
])
const category = (table: string): AccountRetentionCategory => {
  if (table === 'quickbooks_managed_grants') return 'audit_and_security'
  if (
    [
      'time_entries',
      'user_assignments',
      'user_billable_rates',
      'user_cost_rates',
      'timesheet_submissions',
      'timesheet_locks',
      'timesheet_unlocks',
    ].includes(table)
  )
    return 'time_and_worker_attribution'
  if (/invoice|estimate|payment|payout|expense|receivable|quickbooks|wise|bank_deposit|bank_feed/.test(table))
    return 'billing_and_payments'
  return 'audit_and_security'
}
const credentialsQuery = `SELECT json_object('identities', json(COALESCE((SELECT json_group_array(json_object('provider',provider,'subject',provider_subject)) FROM (SELECT provider,provider_subject FROM user_identities WHERE user_id=? ORDER BY provider,provider_subject)), '[]')), 'emails', json(COALESCE((SELECT json_group_array(json_object('address',address,'verified',verified_at IS NOT NULL AND invalidated_at IS NULL)) FROM (SELECT address,verified_at,invalidated_at FROM user_emails WHERE user_id=? ORDER BY id)), '[]')), 'calendar_connections', json(COALESCE((SELECT json_group_array(json_object('provider',provider,'generation',generation,'credential_revision',credential_revision,'status',status,'instance',instance_nonce)) FROM (SELECT provider,generation,credential_revision,status,instance_nonce FROM calendar_connections WHERE user_id=? ORDER BY provider)), '[]')), 'calendar_cleanup', json(COALESCE((SELECT json_group_array(json_object('id',id,'status',status)) FROM (SELECT id,status FROM calendar_cleanup_obligations WHERE user_id=? AND instance_nonce=coalesce((SELECT c.instance_nonce FROM calendar_connections c WHERE c.user_id=calendar_cleanup_obligations.user_id AND c.provider=calendar_cleanup_obligations.provider),(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)) ORDER BY id)), '[]'))) AS snapshot`

export function createAccountClosureRepository(database: Database): AccountClosureStore {
  const client = (database as Database & { $client: Native }).$client
  const activeAdmin = async (id: number) => {
    if (
      !(
        await all(
          client,
          "SELECT id FROM users WHERE id=? AND is_active=1 AND profile='administrator'",
          [id],
        )
      ).length
    )
      throw new AccountClosureError('administrator_required')
  }
  const read = async (requestId: string): Promise<AccountClosureRecord | null> => {
    const rows = await all<
      Omit<AccountClosureRecord, 'policy_snapshot' | 'inventory' | 'retained_identity'> & {
        policy_snapshot: string
        inventory_json: string
        retained_identity: number
      }
    >(
      client,
      'SELECT request_id,user_id,actor_user_id,closed_at,policy_version,policy_snapshot,inventory_json,retained_identity,apple_cleanup FROM account_closures WHERE request_id=?',
      [requestId],
    )
    const row = rows[0]
    if (!row) return null
    const cleanup = (await all<{pending:number;manual_required:number;revoked:number}>(client,"SELECT coalesce(sum(status='pending'),0) AS pending,coalesce(sum(status='manual_required'),0) AS manual_required,coalesce(sum(status='revoked'),0) AS revoked FROM calendar_cleanup_obligations WHERE request_id=?",[requestId]))[0]!
    return {
      request_id: row.request_id,
      user_id: row.user_id,
      actor_user_id: row.actor_user_id,
      closed_at: row.closed_at,
      policy_version: row.policy_version,
      policy_snapshot: parseAccountRetentionPolicy(JSON.parse(row.policy_snapshot)),
      inventory: JSON.parse(row.inventory_json) as AccountClosureInventoryItem[],
      ...(cleanup.pending+cleanup.manual_required+cleanup.revoked>0?{calendar_cleanup:cleanup}:{}),
      retained_identity: row.retained_identity === 1,
      apple_cleanup: row.apple_cleanup,
    }
  }
  // Enumerate restrictive and nullable references alike. New user-linked tables
  // are visible in the review without silently being treated as erased.
  const inventoryQuery = async () => {
    const tables = (
      await all<{ name: string }>(
        client,
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).filter(
      ({ name }) => !name.startsWith('_') && !removedTables.has(name) && !closureTables.has(name),
    )
    const references = isD1(client)
      ? (
          await client.batch(
            tables.map(({ name }) =>
              client.prepare(`PRAGMA foreign_key_list(${identifier(name)})`),
            ),
          )
        ).map((result) => result.results as { table: string; from: string }[])
      : tables.map(
          ({ name }) =>
            client.prepare(`PRAGMA foreign_key_list(${identifier(name)})`).all() as {
              table: string
              from: string
            }[],
        )
    const locations = references.flatMap((refs, index) =>
      refs
        .filter((ref) => ref.table === 'users')
        .map((ref) => ({ table: tables[index]!.name, column: ref.from })),
    )
    const entries = locations.map(
      ({ table, column }) =>
        `json_object('location','${table}.${column}','count',(SELECT count(*) FROM ${identifier(table)} WHERE ${identifier(column)}=(SELECT id FROM subject)),'category','${category(table)}')`,
    )
    entries.push(
      `json_object('location','event_outbox.account_or_actor','count',(SELECT count(*) FROM event_outbox WHERE (aggregate_type='user_account' AND aggregate_id=(SELECT id FROM subject)) OR json_extract(payload_json,'$.actor.id')=(SELECT id FROM subject)),'category','audit_and_security')`,
    )
    entries.push(
      `json_object('location','email_log.recipients','count',(SELECT count(*) FROM email_log WHERE EXISTS (SELECT 1 FROM json_each(to_json) recipient JOIN user_emails address ON lower(address.address)=lower(json_extract(recipient.value,'$.email')) WHERE address.user_id=(SELECT id FROM subject))),'category','audit_and_security')`,
    )
    for (const table of ['email_suppression_events', 'email_suppression_lifts'].filter((table) =>
      tables.some(({ name }) => name === table),
    ))
      entries.push(
        `json_object('location','${table}.address','count',(SELECT count(*) FROM ${table} suppression WHERE EXISTS (SELECT 1 FROM user_emails address WHERE address.user_id=(SELECT id FROM subject) AND lower(address.address)=suppression.address)),'category','audit_and_security')`,
      )
    if (tables.some(({ name }) => name === 'placeholder_assignment_keys'))
      entries.push(
        `json_object('location','placeholder_assignment_keys.assignment_target','count',(SELECT count(*) FROM placeholder_assignment_keys receipt WHERE receipt.actor_id<>(SELECT id FROM subject) AND CAST(json_extract(receipt.result_json,'$.allocation.userId') AS INTEGER)=(SELECT id FROM subject)),'category','audit_and_security')`,
      )
    if (tables.some(({ name }) => name === 'wise_signed_webhook_deliveries'))
      entries.push(
        `json_object('location','wise_all_webhook_deliveries.transfer_id','count',(SELECT count(*) FROM wise_all_webhook_deliveries delivery WHERE EXISTS (SELECT 1 FROM payout_transfers payout WHERE payout.external_transfer_id=delivery.transfer_id AND payout.user_id=(SELECT id FROM subject)) OR EXISTS (SELECT 1 FROM payment_run_items item WHERE item.transfer_id=delivery.transfer_id AND item.user_id=(SELECT id FROM subject))),'category','billing_and_payments')`,
      )
    entries.push(`json_object('location','calendar_connections.external_cleanup','count',
      (SELECT count(*) FROM calendar_connections WHERE user_id=(SELECT id FROM subject) AND sealed_grant IS NOT NULL)
      +(SELECT count(*) FROM calendar_cleanup_obligations WHERE user_id=(SELECT id FROM subject) AND instance_nonce=coalesce((SELECT c.instance_nonce FROM calendar_connections c WHERE c.user_id=calendar_cleanup_obligations.user_id AND c.provider=calendar_cleanup_obligations.provider),(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)) AND status<>'revoked'),
      'category','audit_and_security')`)
    // D1 has tighter compound-SELECT and function-argument limits than SQLite.
    // Each bounded array contains objects, so trimming its outer brackets is exact.
    const groups: string[] = []
    for (let offset = 0; offset < entries.length; offset += 20)
      groups.push(`trim(json_array(${entries.slice(offset, offset + 20).join(',')}),'[]')`)
    return `WITH subject AS (SELECT ? AS id) SELECT COALESCE(json_group_array(json(value)),'[]') AS inventory FROM json_each('[' || ${groups.join(" || ',' || ")} || ']') WHERE json_extract(value,'$.count')>0`
  }
  const inspect = async (actor: number, id: string) => {
    await activeAdmin(actor)
    const rows = await all<{
      user_id: number
      version: number
      is_owner: number
      user_version: number
    }>(
      client,
      'SELECT request.user_id,request.version,person.is_owner,person.version AS user_version FROM account_deletion_requests request JOIN users person ON person.id=request.user_id WHERE request.id=?',
      [id],
    )
    if (!rows[0]) throw new AccountClosureError('request_not_found')
    const person = rows[0]
    const running =
      (
        await all(
          client,
          'SELECT id FROM time_entries WHERE user_id=? AND (timer_started_at IS NOT NULL OR (started_time IS NOT NULL AND ended_time IS NULL)) LIMIT 1',
          [person.user_id],
        )
      ).length > 0
    const policies = await all<{ version: number; policy_json: string }>(
      client,
      'SELECT version,policy_json FROM account_retention_policies ORDER BY version DESC LIMIT 1',
    )
    const policy = policies[0]
    const query = await inventoryQuery()
    const inventoryJson = (await all<{ inventory: string }>(client, query, [person.user_id]))[0]!
      .inventory
    const inventory = JSON.parse(inventoryJson) as AccountClosureInventoryItem[]
    const selected = policy
      ? parseAccountRetentionPolicy(JSON.parse(policy.policy_json)).retained_records.map(
          (rule) => rule.category,
        )
      : []
    const uncovered = [...new Set(inventory.map((item) => item.category))].filter(
      (value) => !selected.includes(value),
    )
    const secret = (
      await all<{ secret: string }>(
        client,
        'SELECT secret FROM account_closure_security WHERE id=1',
      )
    )[0]!.secret
    const snapshot = (
      await all<{ snapshot: string }>(client, credentialsQuery, [person.user_id, person.user_id, person.user_id, person.user_id])
    )[0]!.snapshot
    const reviewToken = accountClosureDigest(
      secret,
      'review',
      JSON.stringify([
        id,
        person.version,
        person.user_version,
        policy?.version ?? null,
        inventoryJson,
        snapshot,
      ]),
    )
    return {
      secret,
      snapshot,
      person,
      policy,
      query,
      inventoryJson,
      preview: {
        request_id: id,
        user_id: person.user_id,
        request_version: person.version,
        review_token: reviewToken,
        policy_version: policy?.version ?? null,
        policy_snapshot: policy
          ? parseAccountRetentionPolicy(JSON.parse(policy.policy_json))
          : null,
        inventory,
        uncovered_categories: uncovered,
        owner_transfer_required: person.is_owner === 1,
        running_timer: running,
        closure: await read(id),
      } satisfies AccountClosurePreview,
    }
  }
  return {
    async preview(actor: number, id: string): Promise<AccountClosurePreview> {
      return (await inspect(actor, id)).preview
    },
    async close(input: {
      actorUserId: number
      id: string
      expectedVersion: number
      reviewToken: string
      expectedPolicyVersion: number
      now: string
      acknowledged: true
    }): Promise<AccountClosureRecord> {
      if (
        input.acknowledged !== true ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        !Number.isFinite(Date.parse(input.now)) ||
        new Date(input.now).toISOString() !== input.now
      )
        throw new RangeError('Invalid account closure metadata')
      const reviewed = await inspect(input.actorUserId, input.id)
      if (reviewed.preview.closure) return reviewed.preview.closure
      if (reviewed.preview.running_timer) throw new AccountClosureError('running_timer')
      if (reviewed.person.is_owner === 1) throw new AccountClosureError('owner_transfer_required')
      if (reviewed.person.version !== input.expectedVersion)
        throw new AccountClosureError('stale_request')
      if (!reviewed.policy || reviewed.policy.version !== input.expectedPolicyVersion)
        throw new AccountClosureError('stale_policy')
      if (input.reviewToken !== reviewed.preview.review_token)
        throw new AccountClosureError('concurrent_change')
      if (reviewed.preview.uncovered_categories.length)
        throw new AccountClosureError('retention_review_required')
      const userId = reviewed.person.user_id
      // Keep the exact directory snapshot covered by the operator's review token.
      // A second read here could silently bless an identity linked after inspection.
      const { secret, snapshot } = reviewed
      const credentials = JSON.parse(snapshot) as {
        identities: { provider: string; subject: string }[]
        emails: { address: string; verified: number }[]
      }
      const keys = [
        ...credentials.identities.map((identity) => ({
          kind: 'provider',
          provider: identity.provider,
          digest: accountClosureDigest(
            secret,
            'provider',
            closedAccountProviderKey(identity.provider, identity.subject),
          ),
        })),
        ...credentials.emails
          .filter((email) => email.verified === 1)
          .map((email) => ({
            kind: 'email',
            digest: accountClosureDigest(secret, 'email', email.address.trim().toLowerCase()),
          })),
      ]
      const query = `INSERT INTO account_closures (request_id,user_id,actor_user_id,closed_at,policy_version,policy_snapshot,inventory_json,replay_keys,retained_identity,apple_cleanup)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_deletion_requests WHERE id=? AND user_id=? AND version=? AND status<>'completed')
          AND EXISTS (SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile='administrator')
          AND EXISTS (SELECT 1 FROM users WHERE id=? AND version=?)
          AND (SELECT max(version) FROM account_retention_policies)=?
          AND NOT EXISTS (SELECT 1 FROM time_entries WHERE user_id=? AND (timer_started_at IS NOT NULL OR (started_time IS NOT NULL AND ended_time IS NULL)))
          AND (${credentialsQuery})=? AND (${reviewed.query})=?
        ON CONFLICT(request_id) DO NOTHING RETURNING request_id`
      // Both guards and all cleanup triggers execute within this one statement.
      try {
        await all(client, query, [
          input.id,
          userId,
          input.actorUserId,
          input.now,
          reviewed.policy.version,
          reviewed.policy.policy_json,
          reviewed.inventoryJson,
          JSON.stringify(keys),
          reviewed.preview.inventory.some(
            (item) =>
              item.category === 'time_and_worker_attribution' ||
              item.category === 'billing_and_payments',
          )
            ? 1
            : 0,
          credentials.identities.some((identity) => identity.provider === 'apple')
            ? 'pending'
            : 'not_linked',
          input.id,
          userId,
          input.expectedVersion,
          input.actorUserId,
          userId,
          reviewed.person.user_version,
          input.expectedPolicyVersion,
          userId,
          userId,
          userId,
          userId,
          userId,
          snapshot,
          userId,
          reviewed.inventoryJson,
        ])
      } catch (error) {
        if (
          error instanceof Error &&
          /account closure requires administrator|owner cannot be deactivated|retain an active administrator/.test(
            error.message,
          )
        )
          throw new AccountClosureError('concurrent_change')
        throw error
      }
      if (input.actorUserId !== userId) await activeAdmin(input.actorUserId)
      const closed = await read(input.id)
      if (!closed) throw new AccountClosureError('concurrent_change')
      return closed
    },
  }
}
