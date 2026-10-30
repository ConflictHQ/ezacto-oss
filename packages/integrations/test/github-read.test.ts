import { describe, expect, it } from 'vitest'
import {
  decideGithubRetry,
  githubIssueToRemoteItem,
  interpretGithubEvent,
  maximumGithubWebhookBodyBytes,
  mergeGithubRemoteItem,
  parseGithubIssueReference,
  signGithubBody,
  verifyGithubDelivery,
  type GithubRemoteItem,
} from '../src/work-items/github-read.js'
import { FakeGithubReadStore } from './fixtures/fake-github-read-store.js'
import { describeGithubReadStore } from './fixtures/github-read-store-suite.js'

const repo = { repositoryId: '77', fullName: 'Acme/App' }
const wire = (over: Record<string, unknown> = {}) => ({
  id: 1001,
  number: 5,
  html_url: 'https://github.com/acme/app/issues/5',
  title: 'Fix it',
  state: 'open',
  updated_at: '2026-10-01T10:00:00Z',
  ...over,
})
const scope = { connectionId: 'c1', repository: repo }
const bytes = (s: string) => new TextEncoder().encode(s)

describe('github reference and issue mapping', () => {
  it('[security] accepts only owner/repo#n and github.com issue URLs', () => {
    expect(parseGithubIssueReference('Acme/App#5')?.alias).toBe('acme/app#5')
    expect(parseGithubIssueReference('https://github.com/acme/app/issues/5')?.number).toBe(5)
    for (const bad of [
      'https://evil.test/acme/app/issues/5',
      'https://github.com.evil.test/acme/app/issues/5',
      'https://user:pw@github.com/acme/app/issues/5',
      'https://github.com:8443/acme/app/issues/5',
      'https://github.com/acme/app/pull/5',
      'http://github.com/acme/app/issues/5',
      'https://github.com/acme/app/issues/5?private=secret',
      'https://github.com/acme/app/issues/5#private',
      'acme/app#0',
      '../x#1',
      'acme/app#5 extra',
    ]) {
      expect(parseGithubIssueReference(bad), bad).toBeNull()
    }
  })

  it('[unit] maps an issue and filters pull requests', () => {
    expect(githubIssueToRemoteItem(wire(), scope)).toMatchObject({
      issueId: '1001',
      state: 'open',
      aliases: ['acme/app#5'],
      status: 'visible',
    })
    expect(githubIssueToRemoteItem(wire({ pull_request: { url: 'x' } }), scope)).toBeNull()
  })

  it('[security] refuses a response naming another origin, number or state', () => {
    expect(
      githubIssueToRemoteItem(wire({ html_url: 'https://evil.test/acme/app/issues/5' }), scope),
    ).toBeNull()
    expect(
      githubIssueToRemoteItem(wire({ html_url: 'https://github.com/acme/app/issues/6' }), scope),
    ).toBeNull()
    expect(githubIssueToRemoteItem(wire({ state: 'merged' }), scope)).toBeNull()
    expect(githubIssueToRemoteItem(wire({ id: '1001' }), scope)).toBeNull()
    for (const url of [
      'https://u:pw@github.com/acme/app/issues/5',
      'https://github.com/acme/app/issues/5?secret=value',
      'https://github.com/acme/app/issues/5#private',
    ])
      expect(githubIssueToRemoteItem(wire({ html_url: url }), scope)).toBeNull()
    expect(githubIssueToRemoteItem(null, scope)).toBeNull()
  })

  it('[unit] keeps both spellings after a repository rename', () => {
    const item = githubIssueToRemoteItem(
      wire({ html_url: 'https://github.com/acme/renamed/issues/5' }),
      { ...scope, acceptedFullNames: ['Acme/Renamed'] },
    )
    expect(item?.aliases).toEqual(['acme/app#5', 'acme/renamed#5'])
  })

  it('[security] refuses an issue of another repository unless its name was accepted', () => {
    const foreign = wire({ html_url: 'https://github.com/evil/other/issues/5' })
    expect(githubIssueToRemoteItem(foreign, scope)).toBeNull()
    expect(githubIssueToRemoteItem(foreign, { ...scope, acceptedFullNames: ['acme/x'] })).toBeNull()
    expect(
      githubIssueToRemoteItem(wire({ html_url: 'https://github.com/ACME/APP/issues/5' }), scope),
    ).toMatchObject({ aliases: ['acme/app#5'] })
  })

  it('[security] rejects dot repository names', () => {
    expect(parseGithubIssueReference('owner/..#1')).toBeNull()
    expect(parseGithubIssueReference('owner/.#1')).toBeNull()
    expect(parseGithubIssueReference('https://github.com/owner/../issues/1')).toBeNull()
    expect(parseGithubIssueReference('owner/.github#1')?.number).toBe(1)
  })

  it('[unit] merge rule: newer wins, older and same-revision conflict are stale, aliases grow', () => {
    const base = githubIssueToRemoteItem(wire(), scope) as GithubRemoteItem
    const newer = { ...base, title: 'B', remoteUpdatedAt: '2026-10-02T00:00:00Z' }
    expect(mergeGithubRemoteItem(null, base).outcome).toBe('inserted')
    expect(mergeGithubRemoteItem(base, newer).outcome).toBe('updated')
    expect(mergeGithubRemoteItem(newer, base).outcome).toBe('stale')
    expect(mergeGithubRemoteItem(base, { ...base, title: 'tie' }).outcome).toBe('stale')
    expect(mergeGithubRemoteItem(base, base).outcome).toBe('unchanged')
    expect(() => mergeGithubRemoteItem(base, { ...base, issueId: '9' })).toThrow(RangeError)
    const revived = mergeGithubRemoteItem({ ...base, status: 'unavailable' }, newer)
    expect(revived.item.status).toBe('visible')
    const gone = { ...base, status: 'unavailable' as const }
    expect(mergeGithubRemoteItem(gone, base)).toMatchObject({
      outcome: 'updated',
      item: { status: 'visible' },
    })
    const older = { ...base, remoteUpdatedAt: '2026-09-01T00:00:00Z' }
    expect(mergeGithubRemoteItem(gone, older)).toMatchObject({
      outcome: 'stale',
      item: { status: 'unavailable' },
    })
  })
})

describe('github webhook verification', () => {
  const secret = 's3cret'
  const headers = (sig: string | undefined) => ({
    'x-hub-signature-256': sig,
    'x-github-delivery': 'd-1',
    'x-github-event': 'issues',
  })

  it('[security] verifies the raw bytes and rejects tampering, missing and malformed signatures', async () => {
    const body = bytes('{"a":1}')
    const sig = await signGithubBody(secret, body)
    expect(await verifyGithubDelivery(secret, { headers: headers(sig), body })).toEqual({
      verified: true,
      deliveryId: 'd-1',
      event: 'issues',
    })
    expect(
      await verifyGithubDelivery(secret, { headers: headers(sig), body: bytes('{"a":2}') }),
    ).toEqual({ verified: false, reason: 'bad_signature' })
    expect(await verifyGithubDelivery('other', { headers: headers(sig), body })).toEqual({
      verified: false,
      reason: 'bad_signature',
    })
    expect(await verifyGithubDelivery(secret, { headers: headers(undefined), body })).toEqual({
      verified: false,
      reason: 'missing_signature',
    })
    expect(await verifyGithubDelivery(secret, { headers: headers('sha1=abc'), body })).toEqual({
      verified: false,
      reason: 'bad_signature',
    })
    expect(
      await verifyGithubDelivery(secret, { headers: { 'x-hub-signature-256': sig }, body }),
    ).toEqual({ verified: false, reason: 'malformed' })
  })

  it('[security] refuses an oversize body before any HMAC', async () => {
    const body = new Uint8Array(maximumGithubWebhookBodyBytes + 1)
    expect(
      await verifyGithubDelivery(secret, { headers: headers('sha256=' + '0'.repeat(64)), body }),
    ).toEqual({ verified: false, reason: 'too_large' })
  })

  it('[unit] a multi-repository removal reports every repository once', () => {
    expect(
      interpretGithubEvent('installation_repositories', {
        action: 'removed',
        repositories_removed: [{ id: 77 }, { id: 78 }, { id: 77 }, { id: 'x' }, null, { id: 79 }],
      }),
    ).toEqual({
      kind: 'repositories_lost',
      repositoryIds: ['77', '78', '79'],
      why: 'access_removed',
    })
    for (const payload of [
      { action: 'added', repositories_added: [{ id: 1 }] },
      { action: 'removed', repositories_removed: [] },
      { action: 'removed', repositories_removed: [{ id: 'x' }] },
    ]) {
      expect(interpretGithubEvent('installation_repositories', payload)).toEqual({
        kind: 'ignored',
      })
    }
    expect(
      interpretGithubEvent('installation', { action: 'unsuspend', installation: { id: 9 } }),
    ).toEqual({
      kind: 'ignored',
    })
  })

  it('[security] an empty secret is a verdict, not a throw', async () => {
    const body = bytes('{}')
    expect(
      await verifyGithubDelivery('', {
        headers: headers(await signGithubBody('x', body)),
        body,
      }),
    ).toEqual({ verified: false, reason: 'bad_signature' })
  })

  it('[unit] interprets only the events the contract names', () => {
    const repository = { id: 77, full_name: 'acme/new' }
    expect(
      interpretGithubEvent('issues', { action: 'edited', repository, issue: wire() }),
    ).toMatchObject({ kind: 'issue', repositoryId: '77' })
    expect(
      interpretGithubEvent('issues', { action: 'labeled', repository, issue: wire() }),
    ).toEqual({ kind: 'ignored' })
    expect(
      interpretGithubEvent('issues', { action: 'deleted', repository, issue: wire() }),
    ).toEqual({ kind: 'issue_removed', repositoryId: '77', issueId: '1001' })
    expect(interpretGithubEvent('repository', { action: 'renamed', repository })).toEqual({
      kind: 'repository_renamed',
      repositoryId: '77',
      fullName: 'acme/new',
    })
    expect(interpretGithubEvent('repository', { action: 'transferred', repository })).toMatchObject(
      { kind: 'repository_lost', why: 'transferred' },
    )
    expect(
      interpretGithubEvent('installation', { action: 'deleted', installation: { id: 9 } }),
    ).toEqual({ kind: 'installation_lost', installationId: '9', why: 'uninstalled' })
    expect(
      interpretGithubEvent('installation_repositories', {
        action: 'removed',
        repositories_removed: [{ id: 77 }],
      }),
    ).toEqual({ kind: 'repositories_lost', repositoryIds: ['77'], why: 'access_removed' })
    expect(interpretGithubEvent('push', {})).toEqual({ kind: 'ignored' })
    expect(interpretGithubEvent('issues', 'nope')).toEqual({ kind: 'ignored' })
  })
})

describe('github retry decisions', () => {
  const base = { attempt: 0, now: 1_000_000, random: () => 0 }
  it('[unit] honours retry-after, then a drained rate limit reset, then backoff', () => {
    expect(decideGithubRetry({ ...base, status: 429, headers: { 'retry-after': '30' } })).toEqual({
      action: 'retry',
      reason: 'rate_limited',
      notBefore: 1_030_000,
    })
    expect(
      decideGithubRetry({
        ...base,
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1100' },
      }),
    ).toEqual({ action: 'retry', reason: 'rate_limited', notBefore: 1_100_000 })
    expect(decideGithubRetry({ ...base, attempt: 2, status: 429, headers: {} })).toEqual({
      action: 'retry',
      reason: 'rate_limited',
      notBefore: 1_004_000,
    })
  })
  it('[unit] bounds jitter to 25 percent and attempts to five', () => {
    const d = decideGithubRetry({ ...base, status: 503, headers: {}, random: () => 99 })
    expect(d).toEqual({ action: 'retry', reason: 'server_error', notBefore: 1_001_250 })
    expect(decideGithubRetry({ ...base, attempt: 5, status: 503, headers: {} })).toEqual({
      action: 'stop',
      reason: 'gave_up',
    })
  })
  it('[unit] stops on revoked credentials, lost scope and missing items', () => {
    expect(decideGithubRetry({ ...base, status: 401, headers: {} })).toEqual({
      action: 'stop',
      reason: 'invalid_credentials',
    })
    expect(decideGithubRetry({ ...base, status: 403, headers: {} })).toEqual({
      action: 'stop',
      reason: 'lost_scope',
    })
    expect(decideGithubRetry({ ...base, status: 404, headers: {} })).toEqual({
      action: 'stop',
      reason: 'item_unavailable',
    })
    expect(decideGithubRetry({ ...base, status: 200, headers: {} })).toEqual({ action: 'ok' })
  })
})

describeGithubReadStore(
  'in-memory fake',
  () => new FakeGithubReadStore(),
  (store, index) => {
    ;(store as FakeGithubReadStore).failBatchAtItem = index
  },
)
