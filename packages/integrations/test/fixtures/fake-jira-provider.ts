import {
  JiraProviderError,
  planJiraWorklog,
  type JiraConnectionBinding,
  type JiraIssueSnapshot,
  type JiraWebhookVerdict,
  type JiraWorklog,
  type JiraWorklogInput,
  type JiraWorklogPage,
  type JiraWorklogProvider,
} from '../../src/work-items/jira.js'

/** In-memory Jira. Failure knobs let the contract suite drive scope loss, rate limits and timeout-after-write. */
export class FakeJiraProvider implements JiraWorklogProvider {
  readonly issues = new Map<string, JiraIssueSnapshot>()
  readonly worklogs: JiraWorklog[] = []
  readonly seenDeliveries = new Set<string>()
  grantedScopes = new Set(['read:jira-work', 'write:jira-work'])
  rateLimitedFor: number | undefined
  timeoutAfterNextWrite = false
  private readonly byKey = new Map<string, string>()

  constructor(
    readonly binding: JiraConnectionBinding,
    readonly secret = 'jira-secret',
  ) {}

  async verifyWebhook(request: {
    headers: Readonly<Record<string, string | undefined>>
    body: string
  }): Promise<JiraWebhookVerdict> {
    // The body's cloud id is untrusted; only the credential's binding counts.
    if (request.headers['x-hub-signature'] !== `sha256=${this.secret}`) return { verified: false }
    const id = request.headers['x-atlassian-webhook-identifier']
    if (id === undefined || this.seenDeliveries.has(id)) return { verified: false }
    this.seenDeliveries.add(id)
    return { verified: true, deliveryId: id }
  }

  async fetchIssue(issueId: string): Promise<JiraIssueSnapshot | null> {
    this.guard('read:jira-work')
    const issue = this.issues.get(issueId)
    if (issue === undefined || !this.binding.projectKeys.includes(issue.projectKey)) return null
    return issue
  }

  async createWorklog(input: JiraWorklogInput) {
    this.guard('write:jira-work')
    const plan = planJiraWorklog(input, this.binding)
    if (plan.status === 'held') throw new JiraProviderError('forbidden')
    const marker = `marker:${input.idempotencyKey}`
    const existing = this.worklogs.find((w) => w.marker === marker)
    if (existing !== undefined) return { worklog: existing, created: false }
    const worklog: JiraWorklog = {
      worklogId: `wl-${this.worklogs.length + 1}`,
      issueId: input.issueId,
      authorAccountId: this.binding.authorAccountId,
      ...plan.body,
      marker,
      updatedAt: '2026-10-01T00:00:00.000Z',
    }
    this.worklogs.push(worklog)
    this.byKey.set(input.idempotencyKey, worklog.worklogId)
    if (this.timeoutAfterNextWrite) {
      this.timeoutAfterNextWrite = false
      throw new JiraProviderError('ambiguous')
    }
    return { worklog, created: true }
  }

  async listWorklogs(
    issueId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<JiraWorklogPage> {
    this.guard('read:jira-work')
    const all = this.worklogs.filter((w) => w.issueId === issueId)
    const start = cursor === undefined ? 0 : Number(cursor)
    const worklogs = all.slice(start, start + limit)
    const next = start + limit
    return next < all.length ? { worklogs, nextCursor: String(next) } : { worklogs }
  }

  private guard(scope: string): void {
    if (this.rateLimitedFor !== undefined)
      throw new JiraProviderError('rate_limited', this.rateLimitedFor)
    if (!this.grantedScopes.has(scope)) throw new JiraProviderError('scope_missing')
  }
}
