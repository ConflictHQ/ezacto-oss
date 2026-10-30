import BetterSqlite3 from 'better-sqlite3'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { EzactoClient } from '@conflict-hq/ezacto-client'
import { normalizeBaseUrl } from './config.js'

const safeCursor = (value: string | undefined) =>
  value === undefined || (value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value))
/** Metadata inspection is read-only; all resolution requires an authenticated live administrator. */
export const calendarCleanupCommand = async (
  args: readonly string[],
  runtime: { readStdin(): Promise<string>; stdout(text: string): void },
) => {
  const [action, value, after, ...extra] = args
  if (action === 'inspect') {
    if (!value || extra.length || !safeCursor(after))
      throw new Error('usage: ez calendar-cleanup inspect <canonical database path> [after]')
    const path = resolve(value)
    if (
      lstatSync(path).isSymbolicLink() ||
      realpathSync(path) !== path ||
      existsSync(path + '-wal')
    )
      throw new Error('Use a canonical existing database file.')
    const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
    try {
      const rows = db
        .prepare(
          `SELECT c.id,c.user_id,c.provider,c.instance_nonce,c.generation,c.credential_revision,c.key_id,c.request_id,c.reason,c.status,c.created_at,
        (SELECT nonce FROM calendar_sync_instance WHERE singleton=1) AS review_instance,
        CASE WHEN c.lease_holder IS NOT NULL AND julianday(c.lease_expires_at)>julianday('now') THEN 1 ELSE 0 END AS provider_cleanup_in_progress
        FROM calendar_cleanup_obligations c WHERE c.id>? AND c.status<>'revoked'
        AND (c.instance_nonce<>(SELECT nonce FROM calendar_sync_instance WHERE singleton=1) OR c.reason IN('closure','restore','reset')) ORDER BY c.id LIMIT 101`,
        )
        .all(after ?? '') as Array<Record<string, unknown>>
      runtime.stdout(
        JSON.stringify({
          inspection_only: true,
          data: rows.slice(0, 100).map((row) => ({
            ...row,
            provider_cleanup_in_progress: row.provider_cleanup_in_progress === 1,
          })),
          page: { next_cursor: rows.length > 100 ? rows[99]!.id : null },
        }),
      )
      return 0
    } finally {
      db.close()
    }
  }
  if (
    !['list', 'confirm'].includes(action ?? '') ||
    after !== undefined ||
    extra.length ||
    (action === 'confirm' && value !== undefined) ||
    !safeCursor(value)
  )
    throw new Error(
      'usage: ez calendar-cleanup list [after] | confirm; pipe private session JSON on stdin',
    )
  let input: Record<string, unknown>
  try {
    const raw = await runtime.readStdin()
    if (raw.length > 16384) throw new Error()
    input = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('Pipe bounded private session JSON on stdin.')
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          'base_url',
          'session_cookie',
          'selection',
          'evidence_reference',
          'confirm_provider_removed',
        ].includes(key),
    ) ||
    typeof input.base_url !== 'string' ||
    typeof input.session_cookie !== 'string' ||
    !/^__Host-ezacto_session=[A-Za-z0-9_-]{32,256}$/.test(input.session_cookie)
  )
    throw new Error(
      'Supply base_url and one native session cookie through stdin; never use an API token.',
    )
  const base = normalizeBaseUrl(input.base_url),
    url = new URL(base)
  if (url.protocol !== 'https:') throw new Error('Online calendar cleanup requires HTTPS.')
  const client = new EzactoClient({
    baseUrl: base,
    headers: { cookie: input.session_cookie, origin: url.origin },
    fetch: (request, options) => fetch(request, { ...options, redirect: 'error' }),
  })
  if (action === 'list') {
    if (
      input.selection !== undefined ||
      input.evidence_reference !== undefined ||
      input.confirm_provider_removed !== undefined
    )
      throw new Error('List accepts no confirmation.')
    runtime.stdout(
      JSON.stringify(
        await client.listCalendarOperatorCleanup({
          query: { ...(value ? { after: value } : {}) },
          signal: AbortSignal.timeout(30000),
        }),
      ),
    )
  } else {
    if (
      !input.selection ||
      typeof input.selection !== 'object' ||
      Array.isArray(input.selection) ||
      input.confirm_provider_removed !== true ||
      typeof input.evidence_reference !== 'string'
    )
      throw new Error(
        'Supply the selected review row, protected evidence_reference and confirm_provider_removed:true through stdin.',
      )
    const selected = input.selection as Record<string, unknown>
    const identity = Object.fromEntries(
      [
        'id',
        'user_id',
        'provider',
        'instance_nonce',
        'generation',
        'credential_revision',
        'key_id',
        'request_id',
        'reason',
        'review_instance',
      ].map((key) => [key, selected[key]]),
    )
    const confirmation = {
      ...identity,
      expected_status: selected.status,
      evidence_reference: input.evidence_reference,
      confirm_provider_removed: true,
    }
    const result = await client.confirmCalendarOperatorCleanup({
      body: confirmation as Parameters<EzactoClient['confirmCalendarOperatorCleanup']>[0]['body'],
      signal: AbortSignal.timeout(30000),
    })
    runtime.stdout(JSON.stringify(result))
  }
  return 0
}
