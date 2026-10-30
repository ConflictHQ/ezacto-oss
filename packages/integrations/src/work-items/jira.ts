/**
 * Jira Cloud worklog contract (issue 1178). Contract only: no HTTP, no
 * credential handling, no persistence. A real adapter must satisfy
 * `test/jira-worklog-contract.test.ts`; docs/jira-worklog-contract.md holds
 * the invariants.
 *
 * Jira differs from the comment trackers in `provider.ts`: a worklog is a
 * native record with a start instant, an author and `timeSpentSeconds`, so the
 * day/seconds `WorkItemTimeNote` cannot express it.
 */

/** The OAuth 2.0 (3LO) scopes the adapter may ever request. Never escalated silently. */
export type JiraScope = 'read:jira-work' | 'write:jira-work' | 'offline_access'

/** What each capability needs. Reading never requires a write scope. */
export const JIRA_SCOPES_FOR = {
  read: ['read:jira-work'],
  writeWorklogs: ['read:jira-work', 'write:jira-work'],
} as const satisfies Record<string, readonly JiraScope[]>

/** Bound to the credential at connection time, never taken from a webhook body. */
export interface JiraConnectionBinding {
  readonly cloudId: string
  readonly siteUrl: string
  /** Administrator-selected allowlist. An issue outside it is not found. */
  readonly projectKeys: readonly string[]
  /** The consenting remote author. Writes cover only this account's entries. */
  readonly authorAccountId: string
}

export interface JiraIssueSnapshot {
  /** Immutable numeric issue id as a string. The key can change on a move. */
  readonly issueId: string
  readonly key: string
  readonly url: string
  readonly title: string
  /** The full remote status, kept as is. */
  readonly status: string
  /** The documented projection of `status`; metadata only. */
  readonly state: 'open' | 'closed'
  readonly projectKey: string
  /** Remote update instant (ISO 8601), so an older event cannot restore stale state. */
  readonly updatedAt: string
}

/** One entry to publish. `startedAt` is mandatory: Jira needs it and eZacto never invents one. */
export interface JiraWorklogInput {
  readonly issueId: string
  /** Same key, same remote worklog. */
  readonly idempotencyKey: string
  readonly seconds: number
  /** ISO 8601 instant with a Z or explicit offset (never zone-less), or absent for a duration-only entry. */
  readonly startedAt?: string | undefined
  /** The local entry's UTC offset in minutes at `startedAt` (DST resolved by the caller). */
  readonly utcOffsetMinutes?: number | undefined
  /** Remote account the local person is verified to map to, or absent when unmapped. */
  readonly mappedAccountId?: string | undefined
}

export type JiraHoldReason =
  | 'missing_start'
  | 'invalid_start'
  | 'missing_offset'
  | 'invalid_seconds'
  | 'author_unmapped'
  | 'author_mismatch'

/** The wire body for POST /issue/{id}/worklog. No remaining-estimate field exists here by design. */
export interface JiraWorklogBody {
  /** Jira format: yyyy-MM-ddTHH:mm:ss.SSS+hhmm, in the entry's own offset. */
  readonly started: string
  readonly timeSpentSeconds: number
}

export type JiraWorklogPlan =
  | { readonly status: 'ready'; readonly body: JiraWorklogBody }
  | { readonly status: 'held'; readonly reason: JiraHoldReason }

/** Date, time and a mandatory zone. A zone-less string would parse in the host's timezone. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** Turn an entry into a wire body, or hold it with the reason. Pure. */
export function planJiraWorklog(
  input: JiraWorklogInput,
  binding: JiraConnectionBinding,
): JiraWorklogPlan {
  if (!Number.isInteger(input.seconds) || input.seconds <= 0)
    return { status: 'held', reason: 'invalid_seconds' }
  if (input.startedAt === undefined) return { status: 'held', reason: 'missing_start' }
  if (!ZONED_INSTANT.test(input.startedAt) || Number.isNaN(Date.parse(input.startedAt))) {
    return { status: 'held', reason: 'invalid_start' }
  }
  const offset = input.utcOffsetMinutes
  if (offset === undefined || !Number.isInteger(offset) || Math.abs(offset) > 14 * 60) {
    return { status: 'held', reason: 'missing_offset' }
  }
  if (input.mappedAccountId === undefined) return { status: 'held', reason: 'author_unmapped' }
  if (input.mappedAccountId !== binding.authorAccountId)
    return { status: 'held', reason: 'author_mismatch' }

  const local = new Date(Date.parse(input.startedAt) + offset * 60_000)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const started =
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.${pad(local.getUTCMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  return { status: 'ready', body: { started, timeSpentSeconds: input.seconds } }
}

/**
 * The UTC offset in minutes that `timeZone` (IANA name) has at `instant`, DST
 * included. Callers use it to fill `utcOffsetMinutes`; `planJiraWorklog` never
 * guesses one. Throws RangeError for an unknown zone or an invalid instant.
 */
export function utcOffsetMinutesAt(instant: string, timeZone: string): number {
  const ms = Date.parse(instant)
  if (Number.isNaN(ms)) throw new RangeError('invalid instant')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

/** The marker is bound to the connection (cloud id) as well as the key, so another site's worklog never matches. */
export function jiraMarker(binding: JiraConnectionBinding, idempotencyKey: string): string {
  return `ezacto:${binding.cloudId}:${idempotencyKey}`
}

/**
 * Apply an inbound issue event. An event whose `updatedAt` is not strictly newer
 * than what we hold (or is unparseable) cannot restore old state.
 */
export function applyJiraIssueEvent(
  current: JiraIssueSnapshot | null,
  incoming: JiraIssueSnapshot,
): JiraIssueSnapshot {
  if (current === null) return incoming
  if (current.issueId !== incoming.issueId) return current
  const next = Date.parse(incoming.updatedAt)
  return !Number.isNaN(next) && next > Date.parse(current.updatedAt) ? incoming : current
}

export interface JiraWorklog {
  readonly worklogId: string
  readonly issueId: string
  readonly authorAccountId: string
  readonly started: string
  readonly timeSpentSeconds: number
  /** Connection-bound marker proving the app wrote it (stored as worklog metadata). */
  readonly marker: string
  readonly updatedAt: string
}

export type JiraWorklogState =
  | { readonly state: 'in_sync' }
  | { readonly state: 'edited'; readonly fields: readonly ('started' | 'timeSpentSeconds')[] }
  | { readonly state: 'deleted' }
  /** Present but not ours: wrong marker or wrong author. Never adopt or overwrite it. */
  | { readonly state: 'foreign' }

/** Compare what we published with what Jira holds. A difference is a visible conflict, never a rewrite. */
export function classifyJiraWorklog(
  published: JiraWorklogBody & { readonly marker: string; readonly issueId: string },
  remote: JiraWorklog | null,
  binding: JiraConnectionBinding,
): JiraWorklogState {
  if (remote === null) return { state: 'deleted' }
  if (
    remote.marker !== published.marker ||
    remote.issueId !== published.issueId ||
    remote.authorAccountId !== binding.authorAccountId
  ) {
    return { state: 'foreign' }
  }
  const fields: ('started' | 'timeSpentSeconds')[] = []
  if (remote.started !== published.started) fields.push('started')
  if (remote.timeSpentSeconds !== published.timeSpentSeconds) fields.push('timeSpentSeconds')
  return fields.length === 0 ? { state: 'in_sync' } : { state: 'edited', fields }
}

/** Sanitized failure codes only. No provider body, token or issue text. */
export type JiraFailureCode =
  'scope_missing' | 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'ambiguous'

export class JiraProviderError extends Error {
  constructor(
    readonly code: JiraFailureCode,
    /** Seconds from a Retry-After header, for `rate_limited` only. */
    readonly retryAfterSeconds?: number,
  ) {
    super(code)
    this.name = 'JiraProviderError'
  }
}

/** A local hold surfaced by a provider that was handed an unplannable entry. Not a remote failure. */
export class JiraWorklogHeldError extends Error {
  constructor(readonly reason: JiraHoldReason) {
    super(`held:${reason}`)
    this.name = 'JiraWorklogHeldError'
  }
}

export interface JiraWebhookVerdict {
  readonly verified: boolean
  /** Provider delivery id for replay protection; present only when verified. */
  readonly deliveryId?: string
}

export interface JiraWorklogPage {
  readonly worklogs: readonly JiraWorklog[]
  /** Absent on the last page. Persist only after the whole page is applied. */
  readonly nextCursor?: string
}

/**
 * The credential and `JiraConnectionBinding` are held from construction. No
 * method takes a cloud id, site or token, and no method reads one off a payload.
 */
export interface JiraWorklogProvider {
  verifyWebhook(request: {
    headers: Readonly<Record<string, string | undefined>>
    body: string
  }): Promise<JiraWebhookVerdict>
  /** Null when the issue is gone, outside the project allowlist, or not visible. */
  fetchIssue(issueId: string): Promise<JiraIssueSnapshot | null>
  /**
   * Creates the worklog, or returns the one already made for the key. Throws
   * `JiraProviderError('ambiguous')` when the outcome is unknown; the caller
   * then reconciles with `listWorklogs` before any retry.
   */
  createWorklog(
    input: JiraWorklogInput,
  ): Promise<{ readonly worklog: JiraWorklog; readonly created: boolean }>
  /** Bounded: `limit` caps a page. Reconciliation walks cursors to the end. */
  listWorklogs(issueId: string, cursor: string | undefined, limit: number): Promise<JiraWorklogPage>
}

export type JiraReplayOutcome =
  | { readonly outcome: 'found'; readonly worklog: JiraWorklog }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'hold_for_operator' }

/**
 * After an `ambiguous` create: walk every page looking for our marker. Absence
 * is reported only when the whole listing was read; any listing failure or an
 * unbounded walk holds for an operator, and nothing is retried.
 */
export async function reconcileAmbiguousWorklog(
  provider: JiraWorklogProvider,
  binding: JiraConnectionBinding,
  input: JiraWorklogInput,
  options: { readonly limit?: number; readonly maxPages?: number } = {},
): Promise<JiraReplayOutcome> {
  const limit = options.limit ?? 50
  const maxPages = options.maxPages ?? 20
  const marker = jiraMarker(binding, input.idempotencyKey)
  let cursor: string | undefined
  try {
    for (let page = 0; page < maxPages; page++) {
      const result = await provider.listWorklogs(input.issueId, cursor, limit)
      const worklog = result.worklogs.find(
        (w) => w.marker === marker && w.issueId === input.issueId,
      )
      if (worklog !== undefined) return { outcome: 'found', worklog }
      if (result.nextCursor === undefined) return { outcome: 'absent' }
      cursor = result.nextCursor
    }
  } catch {
    return { outcome: 'hold_for_operator' }
  }
  return { outcome: 'hold_for_operator' }
}

/**
 * Walk worklog pages from `startCursor`. `saveCheckpoint` runs only after
 * `applyPage` resolved for that page, so a failed page is read again.
 * Saves `undefined` when the last page is done.
 */
export async function syncJiraWorklogs(
  provider: JiraWorklogProvider,
  issueId: string,
  startCursor: string | undefined,
  limit: number,
  applyPage: (worklogs: readonly JiraWorklog[]) => Promise<void>,
  saveCheckpoint: (cursor: string | undefined) => Promise<void>,
): Promise<void> {
  let cursor = startCursor
  for (;;) {
    const page = await provider.listWorklogs(issueId, cursor, limit)
    await applyPage(page.worklogs)
    await saveCheckpoint(page.nextCursor)
    if (page.nextCursor === undefined) return
    cursor = page.nextCursor
  }
}
