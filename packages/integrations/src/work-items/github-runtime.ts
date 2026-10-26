import {
  githubIssueToRemoteItem,
  interpretGithubEvent,
  verifyGithubDelivery,
  type GithubReadStore,
  type GithubRemoteItem,
  type GithubRepositoryRef,
} from './github-read.js'
import { GithubHttpError, type GithubReadClient, GithubReadError } from './github-client.js'

/** Only the already-verified metadata projection reaches durable storage. Raw
 * webhook payloads, issue bodies, users, labels and authorization never do. */
export type GithubStoredEffect =
  | { kind: 'item'; item: GithubRemoteItem }
  | { kind: 'removed'; repositoryId: string; issueId: string }
  | { kind: 'resource'; repositoryId: string; state: 'deleted' | 'transferred' | 'access_lost' }
  | { kind: 'rename'; repositoryId: string; fullName: string }
  | { kind: 'revoke' }
  | { kind: 'ignored' }
export interface GithubReaderBinding {
  connectionId: string
  generation: number
  installationId: string
  appId: string
  accountId: string
  repositories: readonly GithubRepositoryRef[]
}
export interface GithubReaderStore extends GithubReadStore {
  enqueueDelivery(
    connectionId: string,
    deliveryId: string,
    bodyHash: string,
    effects: readonly GithubStoredEffect[],
  ): Promise<'pending' | 'applied'>
  applyDelivery(connectionId: string, deliveryId: string): Promise<'applied' | 'duplicate'>
}
export type GithubWebhookOutcome =
  | 'invalid_signature'
  | 'body_too_large'
  | 'invalid_payload'
  | 'foreign_installation'
  | 'ignored'
  | 'applied'
  | 'duplicate'
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))
const repositoryEnvelope = [
  'action',
  'repository',
  'installation',
  'sender',
  'organization',
  'enterprise',
  'changes',
] as const
const installationEnvelope = [
  'action',
  'installation',
  'repositories',
  'sender',
  'requester',
  'organization',
  'enterprise',
] as const
const installationRepositoriesEnvelope = [
  'action',
  'installation',
  'repository_selection',
  'repositories_added',
  'repositories_removed',
  'sender',
  'requester',
  'organization',
  'enterprise',
] as const
const numberId = (value: unknown): string | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
const hash = async (body: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
export const receiveGithubWebhook = async (input: {
  binding: GithubReaderBinding
  store: GithubReaderStore
  secret: string
  body: Uint8Array<ArrayBuffer>
  signature: string | null
  event: string
  deliveryId: string
}): Promise<GithubWebhookOutcome> => {
  const verdict = await verifyGithubDelivery(input.secret, {
    body: input.body,
    headers: {
      'x-hub-signature-256': input.signature ?? undefined,
      'x-github-event': input.event,
      'x-github-delivery': input.deliveryId,
    },
  })
  if (!verdict.verified)
    return verdict.reason === 'too_large' ? 'body_too_large' : 'invalid_signature'
  if (!/^[A-Za-z0-9-]{1,128}$/.test(input.deliveryId)) return 'invalid_payload'
  let payload: Record<string, unknown> | null
  try {
    payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.body)))
  } catch {
    return 'invalid_payload'
  }
  if (!payload) return 'invalid_payload'
  if (numberId(record(payload.installation)?.id) !== input.binding.installationId)
    return 'foreign_installation'
  const effect = interpretGithubEvent(input.event, payload)
  const approved = (id: string) =>
    input.binding.repositories.find((repository) => repository.repositoryId === id)
  const effects: GithubStoredEffect[] = []
  switch (effect.kind) {
    case 'issue': {
      const repository = approved(effect.repositoryId)
      if (repository) {
        const item = githubIssueToRemoteItem(effect.wire, {
          connectionId: input.binding.connectionId,
          repository,
        })
        if (item) effects.push({ kind: 'item', item })
      }
      break
    }
    case 'issue_removed':
      if (approved(effect.repositoryId))
        effects.push({
          kind: 'removed',
          repositoryId: effect.repositoryId,
          issueId: effect.issueId,
        })
      break
    case 'repository_renamed':
      if (
        onlyKeys(payload, repositoryEnvelope) &&
        approved(effect.repositoryId) &&
        numberId(record(record(payload.repository)?.owner)?.id) === input.binding.accountId &&
        /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(effect.fullName) &&
        effect.fullName.length <= 140
      )
        effects.push({
          kind: 'rename',
          repositoryId: effect.repositoryId,
          fullName: effect.fullName,
        })
      break
    case 'repository_lost':
      if (onlyKeys(payload, repositoryEnvelope) && approved(effect.repositoryId))
        effects.push({
          kind: 'resource',
          repositoryId: effect.repositoryId,
          state: effect.why === 'access_removed' ? 'access_lost' : effect.why,
        })
      break
    case 'repositories_lost':
      if (!onlyKeys(payload, installationRepositoriesEnvelope)) break
      for (const id of effect.repositoryIds)
        if (approved(id)) effects.push({ kind: 'resource', repositoryId: id, state: 'access_lost' })
      break
    case 'installation_lost':
      // The event header is not covered by the raw-body HMAC. An issue deletion
      // cannot be relabelled as an installation deletion to revoke the reader.
      if (
        onlyKeys(payload, installationEnvelope) &&
        numberId(record(payload.installation)?.app_id) === input.binding.appId &&
        !('issue' in payload) &&
        !('repository' in payload)
      )
        effects.push({ kind: 'revoke' })
      break
    case 'ignored':
      break
  }
  // Even ignored authenticated deliveries are journalled; raw payload is discarded.
  await input.store.enqueueDelivery(
    input.binding.connectionId,
    input.deliveryId,
    await hash(input.body),
    effects,
  )
  const applied = await input.store.applyDelivery(input.binding.connectionId, input.deliveryId)
  return applied === 'duplicate' ? 'duplicate' : effects.length ? 'applied' : 'ignored'
}

/** One bounded page per tick. Network happens before atomic apply+checkpoint.
 * GitHub's updated-order REST pages are mutable offsets, not a snapshot. An
 * edit/deletion can move an unseen old row behind an already consumed offset.
 * Every finished sweep therefore retains a durable full-rescan obligation:
 * watermark stays null and the next scheduled sweep starts at page one. A
 * completed sweep never certifies completeness while the repository changes.
 */
export const reconcileGithubPage = async (input: {
  binding: GithubReaderBinding
  repository: GithubRepositoryRef
  store: GithubReaderStore
  client: GithubReadClient
  now: number
  attempt: number
}): Promise<'applied' | 'conflict' | 'deferred' | 'unavailable' | 'revoked'> => {
  const report = await input.store.reconciliation(input.binding.connectionId)
  if (report.deferredUntil !== null && report.deferredUntil > input.now) return 'deferred'
  const cp = await input.store.getCheckpoint(
    input.binding.connectionId,
    input.repository.repositoryId,
  )
  // Versioned cursor prevents resuming a legacy incremental scan as a full one.
  let page = 1
  let passStart = new Date(input.now).toISOString()
  if (cp?.status === 'running' && cp.cursor) {
    try {
      const parsed = JSON.parse(cp.cursor) as { page: number; passStart: string; mode?: string }
      if (
        !Number.isSafeInteger(parsed.page) ||
        parsed.page < 1 ||
        parsed.page > 10_000 ||
        !Number.isFinite(Date.parse(parsed.passStart)) ||
        (parsed.mode !== undefined && parsed.mode !== 'full')
      )
        throw new Error()
      // Older cursors (including initial legacy scans with a null watermark)
      // restart once; replay is harmless and cannot silently change page scope.
      if (parsed.mode === 'full' && cp.watermark === null) {
        page = parsed.page
        passStart = parsed.passStart
      }
    } catch {
      throw new GithubReadError('invalid_response')
    }
  }
  try {
    // Revalidate immutable repository/account ownership before trusting a new name.
    const repository = await input.client.repository(
      input.binding.installationId,
      input.repository.repositoryId,
      input.attempt,
    )
    if (repository.accountId !== input.binding.accountId) {
      await input.store.setResourceState(
        input.binding.connectionId,
        input.repository.repositoryId,
        'transferred',
      )
      return 'unavailable'
    }
    if (repository.fullName.toLowerCase() !== input.repository.fullName.toLowerCase())
      await input.store.recordRepositoryName(
        input.binding.connectionId,
        repository.repositoryId,
        repository.fullName,
      )
    const result = await input.client.issues({
      installationId: input.binding.installationId,
      repositoryId: input.repository.repositoryId,
      page,
      since: null,
      attempt: input.attempt,
    })
    const items: GithubRemoteItem[] = []
    for (const wire of result.issues) {
      const candidate = record(wire)
      if (candidate && candidate.pull_request !== undefined && candidate.pull_request !== null)
        continue
      const item = githubIssueToRemoteItem(wire, {
        connectionId: input.binding.connectionId,
        repository,
      })
      // A malformed non-PR row is not evidence that the page was reconciled.
      if (!item) throw new GithubReadError('invalid_response')
      items.push(item)
    }
    const applied = await input.store.applyBatch({
      connectionId: input.binding.connectionId,
      repositoryId: repository.repositoryId,
      expectedVersion: cp?.version ?? 0,
      items,
      next: {
        cursor:
          result.nextPage === null
            ? null
            : JSON.stringify({ mode: 'full', page: result.nextPage, passStart }),
        watermark: null,
        status: result.nextPage === null ? 'complete' : 'running',
      },
    })
    return applied.outcome
  } catch (error) {
    if (!(error instanceof GithubHttpError || error instanceof GithubReadError)) throw error
    const decision = error.decision
    if (decision?.action === 'retry') {
      await input.store.setCooldown(input.binding.connectionId, decision.notBefore)
      return 'deferred'
    }
    if (decision?.action === 'stop' && decision.reason === 'invalid_credentials') {
      await input.store.fence(input.binding.connectionId, 'revoked')
      return 'revoked'
    }
    if (
      decision?.action === 'stop' &&
      (decision.reason === 'lost_scope' || decision.reason === 'item_unavailable')
    ) {
      await input.store.setResourceState(
        input.binding.connectionId,
        input.repository.repositoryId,
        'access_lost',
      )
      return 'unavailable'
    }
    throw error
  }
}
