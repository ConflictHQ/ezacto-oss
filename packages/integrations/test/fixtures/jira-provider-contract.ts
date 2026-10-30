import { describe, expect, it } from 'vitest'
import {
  JiraProviderError,
  jiraMarker,
  reconcileAmbiguousWorklog,
  syncJiraWorklogs,
  type JiraConnectionBinding,
  type JiraIssueSnapshot,
  type JiraWorklog,
  type JiraWorklogInput,
  type JiraWorklogProvider,
} from '../../src/work-items/jira.js'

/** What a provider under test must let the suite do. A real adapter supplies this over a test double or a disposable site. */
export interface JiraContractHarness {
  readonly provider: JiraWorklogProvider
  seedIssue(issue: JiraIssueSnapshot): void
  /** Seed a worklog already present remotely (for foreign-record cases). */
  seedWorklog(worklog: JiraWorklog): void
  revokeScope(scope: 'read:jira-work' | 'write:jira-work'): void
  rateLimit(retryAfterSeconds: number): void
  /** The next successful write reports `ambiguous` to the caller. */
  timeoutAfterNextWrite(): void
  /** A correctly signed delivery with the given id and body. */
  signedWebhook(
    deliveryId: string,
    body: string,
  ): {
    headers: Record<string, string>
    body: string
  }
  /** Worklogs currently stored remotely, for counting. */
  remoteWorklogs(): readonly JiraWorklog[]
}

export type JiraHarnessFactory = (binding: JiraConnectionBinding) => JiraContractHarness

export const contractBinding: JiraConnectionBinding = {
  cloudId: 'cloud-1',
  siteUrl: 'https://example.test',
  projectKeys: ['ABC'],
  authorAccountId: 'acct-leo',
}

export const contractInput: JiraWorklogInput = {
  issueId: '10001',
  idempotencyKey: 'entry-9:2026-10-01',
  seconds: 5400,
  startedAt: '2026-10-01T14:30:00.000Z',
  utcOffsetMinutes: -360,
  mappedAccountId: 'acct-leo',
}

export const contractIssue = (projectKey = 'ABC'): JiraIssueSnapshot => ({
  issueId: '10001',
  key: `${projectKey}-1`,
  url: 'https://example.test/browse/ABC-1',
  title: 'T',
  status: 'In Progress',
  state: 'open',
  projectKey,
  updatedAt: '2026-10-01T00:00:00.000Z',
})

/** Every adapter, fake or real, runs this suite. */
export function runJiraProviderContract(name: string, make: JiraHarnessFactory): void {
  describe(`jira provider contract (${name})`, () => {
    it('[unit] finds nothing outside the project allowlist', async () => {
      const h = make(contractBinding)
      h.seedIssue(contractIssue())
      h.seedIssue({ ...contractIssue('XYZ'), issueId: '20002' })
      expect(await h.provider.fetchIssue('10001')).toMatchObject({ projectKey: 'ABC' })
      expect(await h.provider.fetchIssue('20002')).toBeNull()
    })

    it('[security] replay of the same key creates one remote worklog', async () => {
      const h = make(contractBinding)
      const first = await h.provider.createWorklog(contractInput)
      const replay = await h.provider.createWorklog(contractInput)
      expect(first.created).toBe(true)
      expect(replay).toEqual({ worklog: first.worklog, created: false })
      expect(h.remoteWorklogs()).toHaveLength(1)
    })

    it('[security] the marker is bound to the connection, so a foreign worklog with our key is not adopted', async () => {
      const other = { ...contractBinding, cloudId: 'cloud-2' }
      const h = make(contractBinding)
      h.seedWorklog({
        worklogId: 'foreign-1',
        issueId: contractInput.issueId,
        authorAccountId: contractBinding.authorAccountId,
        started: '2026-10-01T08:30:00.000-0600',
        timeSpentSeconds: 5400,
        marker: jiraMarker(other, contractInput.idempotencyKey),
        updatedAt: '2026-10-01T00:00:00.000Z',
      })
      const result = await h.provider.createWorklog(contractInput)
      expect(result.created).toBe(true)
      expect(result.worklog.worklogId).not.toBe('foreign-1')
      expect(result.worklog.marker).toBe(jiraMarker(contractBinding, contractInput.idempotencyKey))
      expect(h.remoteWorklogs()).toHaveLength(2)
    })

    it('[security] a worklog on another issue with our marker is not adopted', async () => {
      const h = make(contractBinding)
      h.seedWorklog({
        worklogId: 'elsewhere-1',
        issueId: '99999',
        authorAccountId: contractBinding.authorAccountId,
        started: '2026-10-01T08:30:00.000-0600',
        timeSpentSeconds: 5400,
        marker: jiraMarker(contractBinding, contractInput.idempotencyKey),
        updatedAt: '2026-10-01T00:00:00.000Z',
      })
      const result = await h.provider.createWorklog(contractInput)
      expect(result.created).toBe(true)
      expect(result.worklog.issueId).toBe(contractInput.issueId)
    })

    it('[unit] a held entry is a local hold, not a remote failure code', async () => {
      const h = make(contractBinding)
      const err = await h.provider
        .createWorklog({ ...contractInput, startedAt: undefined })
        .catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(JiraProviderError)
      expect(err).toMatchObject({ reason: 'missing_start' })
      expect(h.remoteWorklogs()).toHaveLength(0)
    })

    it('[unit] after timeout-after-write, reconciling finds the worklog by marker and a retry adds none', async () => {
      const h = make(contractBinding)
      h.timeoutAfterNextWrite()
      await expect(h.provider.createWorklog(contractInput)).rejects.toMatchObject({
        code: 'ambiguous',
      })
      const outcome = await reconcileAmbiguousWorklog(h.provider, contractBinding, contractInput)
      expect(outcome).toMatchObject({ outcome: 'found' })
      expect((await h.provider.createWorklog(contractInput)).created).toBe(false)
      expect(h.remoteWorklogs()).toHaveLength(1)
    })

    it('[unit] reconciling reports absence only after reading every page', async () => {
      const h = make(contractBinding)
      for (let i = 0; i < 5; i++)
        await h.provider.createWorklog({ ...contractInput, idempotencyKey: `k${i}` })
      const outcome = await reconcileAmbiguousWorklog(
        h.provider,
        contractBinding,
        { ...contractInput, idempotencyKey: 'never-written' },
        { limit: 2 },
      )
      expect(outcome).toEqual({ outcome: 'absent' })
    })

    it('[unit] reconciling holds for an operator when absence cannot be shown', async () => {
      const h = make(contractBinding)
      for (let i = 0; i < 5; i++)
        await h.provider.createWorklog({ ...contractInput, idempotencyKey: `k${i}` })
      const missing = { ...contractInput, idempotencyKey: 'never-written' }
      // The walk is cut short by the page budget.
      expect(
        await reconcileAmbiguousWorklog(h.provider, contractBinding, missing, {
          limit: 2,
          maxPages: 2,
        }),
      ).toEqual({ outcome: 'hold_for_operator' })
      // Listing fails outright.
      h.rateLimit(30)
      expect(await reconcileAmbiguousWorklog(h.provider, contractBinding, missing)).toEqual({
        outcome: 'hold_for_operator',
      })
    })

    it('[unit] pages worklogs with a bounded limit and a cursor until the last page', async () => {
      const h = make(contractBinding)
      for (let i = 0; i < 5; i++)
        await h.provider.createWorklog({ ...contractInput, idempotencyKey: `k${i}` })
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await h.provider.listWorklogs('10001', cursor, 2)
        expect(page.worklogs.length).toBeLessThanOrEqual(2)
        seen.push(...page.worklogs.map((w) => w.worklogId))
        cursor = page.nextCursor
        pages++
      } while (cursor !== undefined)
      expect(pages).toBe(3)
      expect(new Set(seen).size).toBe(5)
    })

    it('[unit] the checkpoint advances only after a whole page is applied', async () => {
      const h = make(contractBinding)
      for (let i = 0; i < 5; i++)
        await h.provider.createWorklog({ ...contractInput, idempotencyKey: `k${i}` })
      const saved: (string | undefined)[] = []
      let applied = 0
      await expect(
        syncJiraWorklogs(
          h.provider,
          '10001',
          undefined,
          2,
          async () => {
            applied++
            if (applied === 2) throw new Error('apply failed')
          },
          async (c) => {
            saved.push(c)
          },
        ),
      ).rejects.toThrow('apply failed')
      // Page one was applied and saved; page two failed before its save.
      expect(saved).toHaveLength(1)
      expect(saved[0]).toBeDefined()
      // Resuming from the saved checkpoint re-reads the failed page and finishes.
      const resumed: string[] = []
      await syncJiraWorklogs(
        h.provider,
        '10001',
        saved[0],
        2,
        async (w) => {
          resumed.push(...w.map((x) => x.worklogId))
        },
        async (c) => {
          saved.push(c)
        },
      )
      expect(resumed).toHaveLength(3)
      expect(saved.at(-1)).toBeUndefined()
    })

    it('[unit] reports scope loss and rate limits as sanitized codes', async () => {
      const h = make(contractBinding)
      h.revokeScope('write:jira-work')
      await expect(h.provider.createWorklog(contractInput)).rejects.toMatchObject({
        code: 'scope_missing',
      })
      // Reads still work without the write scope.
      h.seedIssue(contractIssue())
      expect(await h.provider.fetchIssue('10001')).toMatchObject({ issueId: '10001' })
      h.rateLimit(30)
      const err = await h.provider.fetchIssue('10001').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(JiraProviderError)
      expect(err).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 })
    })

    it('[security] accepts a delivery once and never lets the body widen the binding', async () => {
      const h = make(contractBinding)
      h.seedIssue(contractIssue())
      h.seedIssue({ ...contractIssue('XYZ'), issueId: '20002' })
      const hostile = JSON.stringify({ cloudId: 'attacker-cloud', projectKeys: ['XYZ'] })
      const req = h.signedWebhook('d-1', hostile)
      expect(await h.provider.verifyWebhook(req)).toEqual({ verified: true, deliveryId: 'd-1' })
      expect(await h.provider.verifyWebhook(req)).toEqual({ verified: false })
      expect(await h.provider.verifyWebhook({ headers: {}, body: hostile })).toEqual({
        verified: false,
      })
      // The hostile body claimed XYZ; the credential's allowlist still hides it.
      expect(await h.provider.fetchIssue('20002')).toBeNull()
    })
  })
}
