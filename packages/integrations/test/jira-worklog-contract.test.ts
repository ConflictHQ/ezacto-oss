import { describe, expect, it } from 'vitest'
import {
  JIRA_SCOPES_FOR,
  JiraProviderError,
  classifyJiraWorklog,
  planJiraWorklog,
  type JiraConnectionBinding,
  type JiraWorklogInput,
} from '../src/work-items/jira.js'
import { FakeJiraProvider } from './fixtures/fake-jira-provider.js'

const binding: JiraConnectionBinding = {
  cloudId: 'cloud-1',
  siteUrl: 'https://example.test',
  projectKeys: ['ABC'],
  authorAccountId: 'acct-leo',
}
const input: JiraWorklogInput = {
  issueId: '10001',
  idempotencyKey: 'entry-9:2026-10-01',
  seconds: 5400,
  startedAt: '2026-10-01T14:30:00.000Z',
  utcOffsetMinutes: -360,
  mappedAccountId: 'acct-leo',
}
const issue = (projectKey = 'ABC') => ({
  issueId: '10001',
  key: `${projectKey}-1`,
  url: 'https://example.test/browse/ABC-1',
  title: 'T',
  status: 'In Progress',
  state: 'open' as const,
  projectKey,
  updatedAt: '2026-10-01T00:00:00.000Z',
})

describe('jira worklog planning', () => {
  it('[unit] formats started in the entry offset and maps seconds', () => {
    expect(planJiraWorklog(input, binding)).toEqual({
      status: 'ready',
      body: { started: '2026-10-01T08:30:00.000-0600', timeSpentSeconds: 5400 },
    })
  })

  it('[unit] resolves the offset on both sides of a DST change as given by the caller', () => {
    const before = planJiraWorklog(
      { ...input, startedAt: '2026-03-08T07:30:00.000Z', utcOffsetMinutes: -420 },
      binding,
    )
    const after = planJiraWorklog(
      { ...input, startedAt: '2026-03-08T10:30:00.000Z', utcOffsetMinutes: -360 },
      binding,
    )
    expect(before).toMatchObject({ body: { started: '2026-03-08T00:30:00.000-0700' } })
    expect(after).toMatchObject({ body: { started: '2026-03-08T04:30:00.000-0600' } })
  })

  it('[unit] holds a duration-only entry instead of inventing a start', () => {
    expect(planJiraWorklog({ ...input, startedAt: undefined }, binding)).toEqual({
      status: 'held',
      reason: 'missing_start',
    })
    expect(planJiraWorklog({ ...input, utcOffsetMinutes: undefined }, binding)).toEqual({
      status: 'held',
      reason: 'missing_offset',
    })
  })

  it('[security] holds an entry whose author is unmapped or is not the consenting account', () => {
    expect(planJiraWorklog({ ...input, mappedAccountId: undefined }, binding)).toEqual({
      status: 'held',
      reason: 'author_unmapped',
    })
    expect(planJiraWorklog({ ...input, mappedAccountId: 'acct-admin' }, binding)).toEqual({
      status: 'held',
      reason: 'author_mismatch',
    })
  })

  it('[unit] rejects non-positive or fractional seconds', () => {
    for (const seconds of [0, -60, 1.5]) {
      expect(planJiraWorklog({ ...input, seconds }, binding)).toEqual({
        status: 'held',
        reason: 'invalid_seconds',
      })
    }
  })

  it('[security] reading never requires the write scope and no scope is implied', () => {
    expect(JIRA_SCOPES_FOR.read).toEqual(['read:jira-work'])
    expect(JIRA_SCOPES_FOR.writeWorklogs).toContain('write:jira-work')
    expect(JIRA_SCOPES_FOR.read).not.toContain('offline_access')
  })
})

describe('jira provider contract (fake)', () => {
  it('[unit] finds nothing outside the project allowlist', async () => {
    const p = new FakeJiraProvider(binding)
    p.issues.set('10001', issue())
    p.issues.set('20002', { ...issue('XYZ'), issueId: '20002' })
    expect(await p.fetchIssue('10001')).toMatchObject({ projectKey: 'ABC' })
    expect(await p.fetchIssue('20002')).toBeNull()
  })

  it('[security] replay of the same key creates one remote worklog', async () => {
    const p = new FakeJiraProvider(binding)
    const first = await p.createWorklog(input)
    const replay = await p.createWorklog(input)
    expect(first.created).toBe(true)
    expect(replay).toEqual({ worklog: first.worklog, created: false })
    expect(p.worklogs).toHaveLength(1)
  })

  it('[unit] after timeout-after-write, listing finds the worklog by marker and a retry adds none', async () => {
    const p = new FakeJiraProvider(binding)
    p.timeoutAfterNextWrite = true
    await expect(p.createWorklog(input)).rejects.toMatchObject({ code: 'ambiguous' })
    const page = await p.listWorklogs('10001', undefined, 50)
    expect(page.worklogs.map((w) => w.marker)).toEqual(['marker:entry-9:2026-10-01'])
    expect((await p.createWorklog(input)).created).toBe(false)
    expect(p.worklogs).toHaveLength(1)
  })

  it('[unit] pages worklogs with a bounded limit and a cursor until the last page', async () => {
    const p = new FakeJiraProvider(binding)
    for (let i = 0; i < 5; i++) await p.createWorklog({ ...input, idempotencyKey: `k${i}` })
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await p.listWorklogs('10001', cursor, 2)
      expect(page.worklogs.length).toBeLessThanOrEqual(2)
      seen.push(...page.worklogs.map((w) => w.worklogId))
      cursor = page.nextCursor
      pages++
    } while (cursor !== undefined)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(5)
  })

  it('[unit] reports scope loss and rate limits as sanitized codes', async () => {
    const p = new FakeJiraProvider(binding)
    p.grantedScopes.delete('write:jira-work')
    await expect(p.createWorklog(input)).rejects.toMatchObject({ code: 'scope_missing' })
    expect(await p.fetchIssue('10001')).toBeNull()
    p.rateLimitedFor = 30
    const err = await p.fetchIssue('10001').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JiraProviderError)
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 })
  })

  it('[security] accepts a delivery once, and trusts the credential binding over the body', async () => {
    const p = new FakeJiraProvider(binding)
    const req = {
      headers: { 'x-hub-signature': 'sha256=jira-secret', 'x-atlassian-webhook-identifier': 'd-1' },
      body: JSON.stringify({ cloudId: 'attacker-cloud' }),
    }
    expect(await p.verifyWebhook(req)).toEqual({ verified: true, deliveryId: 'd-1' })
    expect(await p.verifyWebhook(req)).toEqual({ verified: false })
    expect(await p.verifyWebhook({ headers: {}, body: '{}' })).toEqual({ verified: false })
  })
})

describe('jira remote worklog classification', () => {
  const published = {
    started: '2026-10-01T08:30:00.000-0600',
    timeSpentSeconds: 5400,
    marker: 'm1',
  }
  const remote = {
    worklogId: 'wl-1',
    issueId: '10001',
    authorAccountId: 'acct-leo',
    started: published.started,
    timeSpentSeconds: 5400,
    marker: 'm1',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }

  it('[unit] distinguishes in-sync, edited, deleted and foreign', () => {
    expect(classifyJiraWorklog(published, remote, binding)).toEqual({ state: 'in_sync' })
    expect(classifyJiraWorklog(published, { ...remote, timeSpentSeconds: 60 }, binding)).toEqual({
      state: 'edited',
      fields: ['timeSpentSeconds'],
    })
    expect(classifyJiraWorklog(published, null, binding)).toEqual({ state: 'deleted' })
    expect(classifyJiraWorklog(published, { ...remote, marker: 'other' }, binding)).toEqual({
      state: 'foreign',
    })
    expect(
      classifyJiraWorklog(published, { ...remote, authorAccountId: 'acct-x' }, binding),
    ).toEqual({
      state: 'foreign',
    })
  })
})
