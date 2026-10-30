import { describe, expect, it } from 'vitest'
import {
  JIRA_SCOPES_FOR,
  applyJiraIssueEvent,
  classifyJiraWorklog,
  planJiraWorklog,
  utcOffsetMinutesAt,
  type JiraConnectionBinding,
  type JiraWorklogInput,
} from '../src/work-items/jira.js'
import { fakeJiraHarness } from './fixtures/fake-jira-provider.js'
import { runJiraProviderContract } from './fixtures/jira-provider-contract.js'

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

  it('[unit] derives the offset from a zone on both sides of a DST change', () => {
    // US spring forward 2026-03-08 at 09:00Z; fall back 2026-11-01 at 08:00Z.
    const cases: [string, number, string][] = [
      ['2026-03-08T08:59:00.000Z', -420, '2026-03-08T01:59:00.000-0700'],
      ['2026-03-08T09:00:00.000Z', -360, '2026-03-08T03:00:00.000-0600'],
      ['2026-11-01T07:59:00.000Z', -360, '2026-11-01T01:59:00.000-0600'],
      ['2026-11-01T08:00:00.000Z', -420, '2026-11-01T01:00:00.000-0700'],
    ]
    for (const [startedAt, offset, started] of cases) {
      expect(utcOffsetMinutesAt(startedAt, 'America/Denver')).toBe(offset)
      const plan = planJiraWorklog(
        { ...input, startedAt, utcOffsetMinutes: utcOffsetMinutesAt(startedAt, 'America/Denver') },
        binding,
      )
      expect(plan).toMatchObject({ body: { started } })
    }
    expect(utcOffsetMinutesAt('2026-07-01T00:00:00Z', 'Asia/Kolkata')).toBe(330)
    expect(utcOffsetMinutesAt('2026-07-01T00:00:00Z', 'Europe/London')).toBe(60)
    expect(() => utcOffsetMinutesAt('2026-07-01T00:00:00Z', 'Not/AZone')).toThrow(RangeError)
  })

  it('[unit] requires a Z or explicit offset on startedAt, never the host timezone', () => {
    for (const startedAt of ['2026-10-01', '2026-10-01T08:30:00', 'tomorrow', '2026-10-01T08:30']) {
      expect(planJiraWorklog({ ...input, startedAt }, binding)).toEqual({
        status: 'held',
        reason: 'invalid_start',
      })
    }
    expect(
      planJiraWorklog({ ...input, startedAt: '2026-10-01T08:30:00-06:00' }, binding),
    ).toMatchObject({ body: { started: '2026-10-01T08:30:00.000-0600' } })
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

  it('[security] a stale event cannot restore old issue state', () => {
    const current = {
      ...issue(),
      status: 'Done',
      state: 'closed' as const,
      updatedAt: '2026-10-02T00:00:00.000Z',
    }
    const stale = { ...issue(), updatedAt: '2026-10-01T00:00:00.000Z' }
    const newer = { ...issue(), status: 'Reopened', updatedAt: '2026-10-03T00:00:00.000Z' }
    expect(applyJiraIssueEvent(current, stale)).toBe(current)
    expect(applyJiraIssueEvent(current, { ...stale, updatedAt: current.updatedAt })).toBe(current)
    expect(applyJiraIssueEvent(current, { ...stale, updatedAt: 'garbage' })).toBe(current)
    expect(applyJiraIssueEvent(current, newer)).toBe(newer)
    expect(applyJiraIssueEvent(null, stale)).toBe(stale)
  })

  it('[security] reading never requires the write scope and no scope is implied', () => {
    expect(JIRA_SCOPES_FOR.read).toEqual(['read:jira-work'])
    expect(JIRA_SCOPES_FOR.writeWorklogs).toContain('write:jira-work')
    expect(JIRA_SCOPES_FOR.read).not.toContain('offline_access')
  })
})

runJiraProviderContract('fake', fakeJiraHarness)

describe('jira remote worklog classification', () => {
  const published = {
    started: '2026-10-01T08:30:00.000-0600',
    timeSpentSeconds: 5400,
    marker: 'm1',
    issueId: '10001',
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
    expect(classifyJiraWorklog(published, { ...remote, issueId: '99999' }, binding)).toEqual({
      state: 'foreign',
    })
    expect(
      classifyJiraWorklog(published, { ...remote, authorAccountId: 'acct-x' }, binding),
    ).toEqual({
      state: 'foreign',
    })
  })
})
