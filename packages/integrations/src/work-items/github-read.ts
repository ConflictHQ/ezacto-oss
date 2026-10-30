/**
 * GitHub read-side contract (issue 1175, contract only).
 *
 * Everything here is pure: no network, no credential, no database. It fixes the
 * rules a real GitHub adapter and its SQLite/D1 store must obey, so the plumbing
 * (App credential custody, schema, scheduler) can land later against a settled
 * interface. See docs/github-read-contract.md.
 *
 * Remote metadata is title, state, URL and identity only. Nothing in this file
 * can reach time, money or a project's billing.
 */

/** The only origin a fetch is ever made to. An untrusted URL never becomes a fetch target. */
export const githubApiOrigin = 'https://api.github.com'
export const githubWebOrigin = 'https://github.com'

/** Deliveries larger than this are refused before any parse. */
export const maximumGithubWebhookBodyBytes = 1_048_576
export const maximumGithubBackfillPageSize = 100
export const maximumGithubTitleLength = 1024

// ---------------------------------------------------------------- identity

/** Provider repository ids are immutable; names are not, so names are aliases. */
export interface GithubRepositoryRef {
  readonly repositoryId: string
  /** `owner/name` as last seen. Compared case-insensitively. */
  readonly fullName: string
}

/** `owner/repo#123`, lower-cased: the spelling stored on a link and kept as an alias after a rename. */
export const githubAliasFor = (fullName: string, number: number): string =>
  `${fullName.toLowerCase()}#${number}`

const fullNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u

const validFullName = (fullName: string): boolean => {
  if (!fullNamePattern.test(fullName)) return false
  const name = fullName.slice(fullName.indexOf('/') + 1)
  return name !== '.' && name !== '..'
}

/**
 * Parses an untrusted reference (`owner/repo#123` or a github.com issue URL) into
 * an alias. Anything else, including other hosts, userinfo and ports, is null.
 * The result names *what to ask for*; the request always goes to `githubApiOrigin`.
 */
export const parseGithubIssueReference = (
  value: string,
): { readonly fullName: string; readonly number: number; readonly alias: string } | null => {
  const trimmed = value.trim()
  let fullName: string
  let numberText: string
  const short = /^([^#\s]+)#(\d{1,10})$/u.exec(trimmed)
  if (short !== null) {
    fullName = short[1] ?? ''
    numberText = short[2] ?? ''
  } else {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    if (
      url.origin !== githubWebOrigin ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    )
      return null
    const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d{1,10})\/?$/u.exec(url.pathname)
    if (match === null) return null
    fullName = `${match[1]}/${match[2]}`
    numberText = match[3] ?? ''
  }
  const number = Number(numberText)
  if (!validFullName(fullName) || !Number.isSafeInteger(number) || number < 1) return null
  return { fullName, number, alias: githubAliasFor(fullName, number) }
}

// ------------------------------------------------------------- remote item

export type GithubRemoteItemStatus = 'visible' | 'unavailable'

/** What eZacto keeps of an issue. No body, comments, labels, assignees or users. */
export interface GithubRemoteItem {
  readonly connectionId: string
  /** The immutable GitHub issue id (not the per-repository number), as a decimal string. */
  readonly issueId: string
  readonly repositoryId: string
  readonly number: number
  readonly canonicalUrl: string
  readonly title: string
  readonly state: 'open' | 'closed'
  /** GitHub's `updated_at` (UTC ISO) for the revision this row reflects. */
  readonly remoteUpdatedAt: string
  /** Every spelling ever seen, so a rename or transfer cannot duplicate a link. */
  readonly aliases: readonly string[]
  readonly status: GithubRemoteItemStatus
}

/** The subset of the REST issue object this contract reads. Unknown fields are ignored. */
export interface GithubIssueWire {
  readonly id: number
  readonly number: number
  readonly html_url: string
  readonly title: string
  readonly state: string
  readonly updated_at: string
  /** Present on pull requests, which the issues endpoints also return. */
  readonly pull_request?: unknown
}

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u

/**
 * Converts a wire issue to a stored item, or null for a pull request or any
 * object that does not look like an issue of the approved repository. The
 * canonical URL must be on github.com and name the scope's repository
 * (case-insensitive); another origin, number or repository is refused rather
 * than stored. A repository renamed or transferred since `fullName` was
 * recorded is accepted only when the caller lists its new name in
 * `acceptedFullNames`, which it does after a verified rename for that
 * repository id. The immutable repository id is never taken from the wire.
 */
export const githubIssueToRemoteItem = (
  wire: unknown,
  scope: {
    readonly connectionId: string
    readonly repository: GithubRepositoryRef
    readonly acceptedFullNames?: readonly string[]
  },
): GithubRemoteItem | null => {
  if (typeof wire !== 'object' || wire === null) return null
  const w = wire as Record<string, unknown>
  if ('pull_request' in w && w.pull_request !== undefined && w.pull_request !== null) return null
  const { id, number, html_url: url, title, state, updated_at: updatedAt } = w
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof url !== 'string' ||
    typeof title !== 'string' ||
    (state !== 'open' && state !== 'closed') ||
    typeof updatedAt !== 'string' ||
    !isoPattern.test(updatedAt)
  ) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (
    parsed.origin !== githubWebOrigin ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    return null
  const issuePath = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/u.exec(parsed.pathname)
  if (issuePath === null || Number(issuePath[3]) !== number) return null
  const urlFullName = `${issuePath[1]}/${issuePath[2]}`.toLowerCase()
  const accepted = [scope.repository.fullName, ...(scope.acceptedFullNames ?? [])].map((n) =>
    n.toLowerCase(),
  )
  if (!accepted.includes(urlFullName)) return null
  return {
    connectionId: scope.connectionId,
    issueId: String(id),
    repositoryId: scope.repository.repositoryId,
    number,
    canonicalUrl: parsed.href,
    title: title.slice(0, maximumGithubTitleLength),
    state,
    remoteUpdatedAt: updatedAt,
    aliases: [
      ...new Set([
        githubAliasFor(scope.repository.fullName, number),
        githubAliasFor(urlFullName, number),
      ]),
    ],
    status: 'visible',
  }
}

export type GithubMergeOutcome = 'inserted' | 'updated' | 'unchanged' | 'stale'

/**
 * The one merge rule for backfill and webhooks alike. A revision older than, or
 * equal to but different from, the stored one is `stale` and changes nothing, so
 * an out-of-order delivery cannot restore old state. Aliases only ever grow.
 * An `unavailable` row is revived by a visible revision at least as new as the
 * stored one: an incoming item is always a fresh authenticated read, so after
 * access is restored the same `updated_at` is proof enough. Restoring a
 * resource state alone never revives items; only a successful read does.
 */
export const mergeGithubRemoteItem = (
  existing: GithubRemoteItem | null,
  incoming: GithubRemoteItem,
): { readonly item: GithubRemoteItem; readonly outcome: GithubMergeOutcome } => {
  if (existing === null) return { item: incoming, outcome: 'inserted' }
  if (existing.issueId !== incoming.issueId || existing.connectionId !== incoming.connectionId) {
    throw new RangeError('A merge is for one connection and one immutable issue id.')
  }
  const aliases = [...new Set([...existing.aliases, ...incoming.aliases])]
  const grew = aliases.length !== existing.aliases.length
  if (incoming.remoteUpdatedAt < existing.remoteUpdatedAt) {
    return { item: grew ? { ...existing, aliases } : existing, outcome: 'stale' }
  }
  if (existing.status === 'unavailable')
    return { item: { ...incoming, aliases }, outcome: 'updated' }
  const same =
    incoming.remoteUpdatedAt === existing.remoteUpdatedAt &&
    incoming.title === existing.title &&
    incoming.state === existing.state &&
    incoming.canonicalUrl === existing.canonicalUrl
  if (same) return { item: grew ? { ...existing, aliases } : existing, outcome: 'unchanged' }
  if (incoming.remoteUpdatedAt === existing.remoteUpdatedAt) {
    return { item: grew ? { ...existing, aliases } : existing, outcome: 'stale' }
  }
  return { item: { ...incoming, aliases }, outcome: 'updated' }
}

// ----------------------------------------------------------------- webhook

export type GithubSignatureVerdict =
  | { readonly verified: true; readonly deliveryId: string; readonly event: string }
  | {
      readonly verified: false
      readonly reason: 'too_large' | 'missing_signature' | 'bad_signature' | 'malformed'
    }

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Verifies `X-Hub-Signature-256` over the raw body bytes, before any parse.
 * The size bound is checked first so an oversize body costs no HMAC. The
 * comparison is constant time (HMAC verify), never string equality.
 */
export const verifyGithubDelivery = async (
  secret: string,
  request: {
    readonly headers: Readonly<Record<string, string | undefined>>
    readonly body: Uint8Array<ArrayBuffer>
  },
): Promise<GithubSignatureVerdict> => {
  if (request.body.byteLength > maximumGithubWebhookBodyBytes) {
    return { verified: false, reason: 'too_large' }
  }
  if (secret === '') return { verified: false, reason: 'bad_signature' }
  const header = request.headers['x-hub-signature-256']
  if (header === undefined || header === '') return { verified: false, reason: 'missing_signature' }
  const match = /^sha256=([0-9a-f]{64})$/u.exec(header)
  if (match === null) return { verified: false, reason: 'bad_signature' }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const expected = Uint8Array.from((match[1] ?? '').match(/../gu) ?? [], (h) => parseInt(h, 16))
  const ok = await crypto.subtle.verify('HMAC', key, expected, request.body)
  if (!ok) return { verified: false, reason: 'bad_signature' }
  const deliveryId = request.headers['x-github-delivery']
  const event = request.headers['x-github-event']
  if (!deliveryId || deliveryId.length > 128 || !event || event.length > 64) {
    return { verified: false, reason: 'malformed' }
  }
  return { verified: true, deliveryId, event }
}

/** Test helper and documentation of the exact scheme. */
export const signGithubBody = async (
  secret: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, body)))}`
}

/**
 * What a verified delivery means for eZacto. Everything not listed is `ignored`,
 * including `installation` `unsuspend` and `installation_repositories` `added`:
 * restored access is learned by the next successful read, which revives items
 * through the merge rule, not by trusting an event.
 */
export type GithubEventEffect =
  | { readonly kind: 'issue'; readonly repositoryId: string; readonly wire: unknown }
  | { readonly kind: 'issue_removed'; readonly repositoryId: string; readonly issueId: string }
  | {
      readonly kind: 'repository_renamed'
      readonly repositoryId: string
      readonly fullName: string
    }
  | {
      readonly kind: 'repository_lost'
      readonly repositoryId: string
      readonly why: 'deleted' | 'transferred' | 'access_removed'
    }
  | {
      /** One effect for an `installation_repositories` removal; every id loses access. */
      readonly kind: 'repositories_lost'
      readonly repositoryIds: readonly string[]
      readonly why: 'access_removed'
    }
  | {
      readonly kind: 'installation_lost'
      readonly installationId: string
      readonly why: 'uninstalled' | 'suspended'
    }
  | { readonly kind: 'ignored' }

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const idOf = (value: unknown): string | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null

/**
 * Bounded interpretation of an already-verified delivery. The caller still binds
 * `installationId` and `repositoryId` to the connection's approved allowlist and
 * treats an unapproved one as `ignored`; this function only reads shape.
 * An issue event is applied through `githubIssueToRemoteItem` and the merge rule,
 * which also drops pull requests. Event ordering is never trusted.
 */
export const interpretGithubEvent = (event: string, payload: unknown): GithubEventEffect => {
  if (typeof payload !== 'object' || payload === null) return { kind: 'ignored' }
  const p = payload as Record<string, unknown>
  const action = str(p.action)
  const repository = (p.repository ?? null) as Record<string, unknown> | null
  const repositoryId = repository === null ? null : idOf(repository.id)
  const installationId = idOf((p.installation as Record<string, unknown> | undefined)?.id)
  switch (event) {
    case 'issues': {
      if (repositoryId === null) return { kind: 'ignored' }
      const issue = p.issue as Record<string, unknown> | undefined
      if (issue === undefined || issue === null) return { kind: 'ignored' }
      if (action === 'deleted') {
        const issueId = idOf(issue.id)
        return issueId === null
          ? { kind: 'ignored' }
          : { kind: 'issue_removed', repositoryId, issueId }
      }
      if (action === 'transferred') {
        const issueId = idOf(issue.id)
        return issueId === null
          ? { kind: 'ignored' }
          : { kind: 'issue_removed', repositoryId, issueId }
      }
      const known = ['opened', 'edited', 'closed', 'reopened']
      return action !== null && known.includes(action)
        ? { kind: 'issue', repositoryId, wire: issue }
        : { kind: 'ignored' }
    }
    case 'repository': {
      if (repositoryId === null) return { kind: 'ignored' }
      if (action === 'renamed') {
        const fullName = str(repository?.full_name)
        return fullName === null
          ? { kind: 'ignored' }
          : { kind: 'repository_renamed', repositoryId, fullName }
      }
      if (action === 'deleted') return { kind: 'repository_lost', repositoryId, why: 'deleted' }
      if (action === 'transferred')
        return { kind: 'repository_lost', repositoryId, why: 'transferred' }
      return { kind: 'ignored' }
    }
    case 'installation': {
      if (installationId === null) return { kind: 'ignored' }
      if (action === 'deleted')
        return { kind: 'installation_lost', installationId, why: 'uninstalled' }
      if (action === 'suspend')
        return { kind: 'installation_lost', installationId, why: 'suspended' }
      return { kind: 'ignored' }
    }
    case 'installation_repositories': {
      // Every removed repository loses access, not just the first. `added` is ignored.
      const removed = p.repositories_removed
      if (action !== 'removed' || !Array.isArray(removed)) return { kind: 'ignored' }
      const repositoryIds = [
        ...new Set(
          removed
            .map((r) => idOf((r as Record<string, unknown> | null)?.id))
            .filter((id): id is string => id !== null),
        ),
      ]
      return repositoryIds.length === 0
        ? { kind: 'ignored' }
        : { kind: 'repositories_lost', repositoryIds, why: 'access_removed' }
    }
    default:
      return { kind: 'ignored' }
  }
}

// ----------------------------------------------------------- rate limiting

export type GithubRetryDecision =
  | {
      readonly action: 'retry'
      readonly notBefore: number
      readonly reason: 'rate_limited' | 'server_error'
    }
  | {
      readonly action: 'stop'
      readonly reason: 'invalid_credentials' | 'lost_scope' | 'item_unavailable' | 'gave_up'
    }
  | { readonly action: 'ok' }

export const maximumGithubReadAttempts = 5
const baseBackoffMs = 1_000
const maximumBackoffMs = 5 * 60_000
const maximumRateLimitWaitMs = 60 * 60_000

/**
 * Turns a response into a durable decision. `notBefore` is epoch milliseconds to
 * persist as a per-connection cooldown; nothing sleeps in a request. Provider
 * headers win over our backoff: `retry-after` (seconds), else a drained
 * `x-ratelimit-remaining: 0` until `x-ratelimit-reset` (epoch seconds). `random`
 * is injected (0 to 1) so jitter is testable and bounded to +25%.
 */
export const decideGithubRetry = (input: {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly attempt: number
  readonly now: number
  readonly random: () => number
}): GithubRetryDecision => {
  const { status, headers, attempt, now } = input
  if (status >= 200 && status < 300) return { action: 'ok' }
  if (status === 401) return { action: 'stop', reason: 'invalid_credentials' }
  if (status === 404 || status === 410) return { action: 'stop', reason: 'item_unavailable' }
  const retryAfter = Number(headers['retry-after'])
  const remaining = headers['x-ratelimit-remaining']
  const reset = Number(headers['x-ratelimit-reset'])
  const limited =
    status === 429 ||
    (status === 403 &&
      ((Number.isFinite(retryAfter) && headers['retry-after'] !== undefined) || remaining === '0'))
  if (limited) {
    if (attempt >= maximumGithubReadAttempts) return { action: 'stop', reason: 'gave_up' }
    let wait = baseBackoffMs * 2 ** attempt
    if (headers['retry-after'] !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) {
      wait = retryAfter * 1000
    } else if (remaining === '0' && Number.isFinite(reset)) {
      wait = Math.max(0, reset * 1000 - now)
    }
    const jitter = 1 + 0.25 * Math.min(1, Math.max(0, input.random()))
    return {
      action: 'retry',
      reason: 'rate_limited',
      notBefore: now + Math.ceil(Math.min(wait, maximumRateLimitWaitMs) * jitter),
    }
  }
  if (status === 403) return { action: 'stop', reason: 'lost_scope' }
  if (status >= 500) {
    if (attempt >= maximumGithubReadAttempts) return { action: 'stop', reason: 'gave_up' }
    const wait = Math.min(maximumBackoffMs, baseBackoffMs * 2 ** attempt)
    return {
      action: 'retry',
      reason: 'server_error',
      notBefore: now + Math.ceil(wait * (1 + 0.25 * Math.min(1, Math.max(0, input.random())))),
    }
  }
  return { action: 'stop', reason: 'item_unavailable' }
}

// ------------------------------------------------------------------- store

/** A bounded backfill position for one connection and repository. */
export interface GithubBackfillCheckpoint {
  readonly connectionId: string
  readonly repositoryId: string
  /** The provider's opaque pagination position to fetch next; null at the start. */
  readonly cursor: string | null
  /** Overlap watermark: the next full pass asks for `since` this minus the overlap. */
  readonly watermark: string | null
  /** Optimistic version; every advance increments it. */
  readonly version: number
  readonly status: 'idle' | 'running' | 'complete'
}

export type GithubResourceState = 'active' | 'renamed' | 'transferred' | 'deleted' | 'access_lost'
export type GithubConnectionReadState = 'active' | 'disconnecting' | 'disconnected' | 'revoked'

export interface GithubReadReconciliation {
  readonly connectionId: string
  readonly connectionState: GithubConnectionReadState
  readonly resources: readonly {
    readonly repositoryId: string
    readonly state: GithubResourceState
    readonly checkpoint: GithubBackfillCheckpoint | null
    readonly lastAppliedAt: string | null
  }[]
  readonly deferredUntil: number | null
  /** Closed vocabulary only: never provider text. */
  readonly failureCodes: readonly string[]
  readonly itemsVisible: number
  readonly itemsUnavailable: number
}

export class GithubStoreFencedError extends Error {
  readonly code = 'github_read_fenced' as const
  constructor() {
    super('The GitHub connection is fenced and accepts no new work.')
    this.name = 'GithubStoreFencedError'
  }
}

/**
 * What a real SQLite/D1 store must provide. Provider I/O never happens inside
 * these calls; each is one transaction. The reusable suite in
 * `test/fixtures/github-read-store-suite.ts` is the acceptance test for an
 * implementation.
 */
export interface GithubReadStore {
  /** Journals `(connection, delivery)` once. `duplicate` on any replay. Throws when fenced. */
  recordDelivery(connectionId: string, deliveryId: string): Promise<'new' | 'duplicate'>
  /**
   * Case-insensitive, per connection. A name can be reused by another
   * repository after a rename, so an alias matching items of more than one
   * repository is ambiguous and resolves to null; resolve those by repository id.
   */
  getItemByAlias(connectionId: string, alias: string): Promise<GithubRemoteItem | null>
  getItem(connectionId: string, issueId: string): Promise<GithubRemoteItem | null>
  /** Applies one item through `mergeGithubRemoteItem`. Throws when fenced. */
  applyItem(item: GithubRemoteItem): Promise<GithubMergeOutcome>
  /**
   * Applies a whole backfill page and advances the checkpoint in the same
   * transaction, only if `expectedVersion` still matches. `conflict` leaves
   * everything unchanged. A page that throws midway applies nothing and does not
   * advance. Every item must belong to `connectionId` and `repositoryId`; a
   * foreign item throws `RangeError` and applies nothing. Fencing is checked
   * before the version. Throws when fenced.
   */
  applyBatch(input: {
    readonly connectionId: string
    readonly repositoryId: string
    readonly expectedVersion: number
    readonly items: readonly GithubRemoteItem[]
    readonly next: {
      readonly cursor: string | null
      readonly watermark: string | null
      readonly status: 'running' | 'complete'
    }
  }): Promise<
    | { readonly outcome: 'applied'; readonly checkpoint: GithubBackfillCheckpoint }
    | { readonly outcome: 'conflict' }
  >
  getCheckpoint(
    connectionId: string,
    repositoryId: string,
  ): Promise<GithubBackfillCheckpoint | null>
  /**
   * Records the resource state. `access_lost`, `transferred` and `deleted` mark
   * the repository's items `unavailable` without deleting links or local time;
   * `active` and `renamed` leave item status alone (a later successful read
   * revives). Scoped to the connection. Throws when fenced.
   */
  setResourceState(
    connectionId: string,
    repositoryId: string,
    state: GithubResourceState,
  ): Promise<void>
  /** Adds an alias spelling to every item of a repository (rename/transfer). Throws when fenced. */
  recordRepositoryName(connectionId: string, repositoryId: string, fullName: string): Promise<void>
  /** Persists a rate-limit or backoff cooldown (epoch ms). Never shortens an existing one. Throws when fenced. */
  setCooldown(connectionId: string, notBefore: number): Promise<void>
  /** Fences first: after this resolves no new delivery or batch is accepted. Idempotent. */
  fence(connectionId: string, state: 'disconnecting' | 'disconnected' | 'revoked'): Promise<void>
  reconciliation(connectionId: string): Promise<GithubReadReconciliation>
}
