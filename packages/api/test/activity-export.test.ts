import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installOutboxRoutes,
  type ActivityLogResource,
  type OutboxMonitor,
  type UserProfile,
} from '../src/index.js'
import { ACTIVITY_EXPORT_ROW_LIMIT, renderActivityCsv } from '../src/activity-export.js'

const entry = (n: number, overrides: Partial<ActivityLogResource> = {}): ActivityLogResource => ({
  id: `event-${String(n).padStart(6, '0')}`,
  eventType: 'timesheet.approved',
  aggregateType: 'timesheet_submission',
  aggregateId: 7,
  aggregateSequence: n,
  payload: { secret: 'must not reach the file' },
  occurredAt: '2026-09-02T12:00:00.000Z',
  availableAt: '2026-09-02T12:00:00.000Z',
  // Strictly decreasing, newest first, as the repository returns them.
  recordedAt: `2026-09-02T12:00:00.${String(999 - (n % 1000)).padStart(3, '0')}Z`,
  actor: { type: 'user', id: 4, name: 'Robin Vale' },
  ...overrides,
})

/** A repository over `total` entries that honours `limit` and `after` like the real one. */
const log = (all: readonly ActivityLogResource[]) =>
  vi.fn(async (input: Parameters<OutboxMonitor['listActivity']>[0] = {}) => {
    const start =
      input.after === undefined || input.after === null
        ? 0
        : all.findIndex((row) => row.id === input.after!.eventId) + 1
    return all.slice(start, start + (input.limit ?? 100))
  })

const harness = (
  profile: UserProfile,
  all: readonly ActivityLogResource[],
  enabled = true,
) => {
  const monitor: OutboxMonitor = {
    listActivity: log(all),
    activitySnapshot: vi.fn(async () => '2026-09-02T12:00:01.000Z'),
    deliveriesSnapshot: vi.fn(async () => null),
    pageDeliveries: vi.fn(async () => []),
    countDeliveries: vi.fn(async () => 0),
    retryFailed: vi.fn(async () => null),
  }
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async () => ({
          type: 'user' as const,
          userId: 1,
          profile,
          managerGrants: [],
          authentication: { kind: 'session' as const, sessionId: 'session-1' },
        }),
      },
    },
    installApi(api) {
      installOutboxRoutes(api, monitor, {
        cursorSigningKey: new Uint8Array(32).fill(5),
        timezone: async () => 'UTC',
        isActivityLogModuleEnabled: async () => enabled,
      })
    },
  })
  return { app, monitor }
}

describe('activity log export', () => {
  it('[api] downloads the filtered view as a CSV attachment without the payload', async () => {
    const { app, monitor } = harness('administrator', [entry(1), entry(2, { actor: null })])
    const response = await app.request(
      '/api/v1/activity-log/export?from=2026-09-01&to=2026-09-30&event_type=timesheet.approved' +
        '&aggregate_type=timesheet_submission&aggregate_id=7&actor_id=4',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="activity-log-from-2026-09-01-to-2026-09-30.csv"',
    )
    expect(response.headers.get('x-export-truncated')).toBe('false')
    expect(monitor.listActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-09-01',
        to: '2026-09-30',
        eventType: 'timesheet.approved',
        aggregateType: 'timesheet_submission',
        aggregateId: 7,
        actorId: 4,
      }),
    )
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    // text() decodes the byte-order mark away, which is what a reader sees.
    const body = await response.text()
    expect(body.startsWith('Event id,Event,Occurred at,Recorded at,Subject type,Subject id,')).toBe(true)
    const lines = body.trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(
      'event-000001,timesheet.approved,2026-09-02T12:00:00.000Z,2026-09-02T12:00:00.998Z,' +
        'timesheet_submission,7,user,4,Robin Vale',
    )
    // An entry with no actor is an empty actor, not the word null.
    expect(lines[2]).toMatch(/,timesheet_submission,7,,,$/u)
    expect(body).not.toContain('must not reach the file')
  })

  it('[api] refuses with module_disabled when the module is off, without reading the log', async () => {
    const { app, monitor } = harness('administrator', [entry(1)], false)
    const response = await app.request('/api/v1/activity-log/export')

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'module_disabled' } })
    expect(monitor.listActivity).not.toHaveBeenCalled()
  })

  it('[api] refuses a bad filter with a 422 rather than an empty file', async () => {
    const { app } = harness('administrator', [entry(1)])
    for (const query of ['from=2026-02-30', 'actor_id=abc', 'aggregate_id=7', 'from=2026-09-09&to=2026-09-01']) {
      expect((await app.request(`/api/v1/activity-log/export?${query}`)).status, query).toBe(422)
    }
  })

  it('[security] leaves sign-in, token and deletion events out for a reader who is not an administrator', async () => {
    const { app, monitor } = harness('accounting', [entry(1)])
    expect((await app.request('/api/v1/activity-log/export')).status).toBe(200)
    expect(monitor.listActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeEventTypes: expect.arrayContaining(['auth.signed_in', 'api_token.created']),
      }),
    )

    const admin = harness('administrator', [entry(1)])
    await admin.app.request('/api/v1/activity-log/export')
    expect(admin.monitor.listActivity).toHaveBeenCalledWith(
      expect.not.objectContaining({ excludeEventTypes: expect.anything() }),
    )
  })

  it('[security] a member without the report scope cannot export', async () => {
    const { app, monitor } = harness('member', [entry(1)])
    expect((await app.request('/api/v1/activity-log/export')).status).toBe(403)
    expect(monitor.listActivity).not.toHaveBeenCalled()
  })

  it('[api] walks past one page and stops at the cap with a truncation marker', async () => {
    const all = Array.from({ length: ACTIVITY_EXPORT_ROW_LIMIT + 50 }, (_, index) => entry(index + 1))
    const { app } = harness('administrator', all)
    const response = await app.request('/api/v1/activity-log/export')

    expect(response.headers.get('x-export-truncated')).toBe('true')
    expect(response.headers.get('x-export-row-limit')).toBe(String(ACTIVITY_EXPORT_ROW_LIMIT))
    const lines = (await response.text()).trimEnd().split('\r\n')
    // Header, the capped rows, and the marker line.
    expect(lines).toHaveLength(ACTIVITY_EXPORT_ROW_LIMIT + 2)
    expect(lines[lines.length - 1]).toContain('Truncated')
    expect(lines[ACTIVITY_EXPORT_ROW_LIMIT]).toContain(`event-${String(ACTIVITY_EXPORT_ROW_LIMIT).padStart(6, '0')}`)
  })

  it('[api] a log exactly at the cap is not reported as cut', async () => {
    const all = Array.from({ length: ACTIVITY_EXPORT_ROW_LIMIT }, (_, index) => entry(index + 1))
    const { app } = harness('administrator', all)
    const response = await app.request('/api/v1/activity-log/export')

    expect(response.headers.get('x-export-truncated')).toBe('false')
    const lines = (await response.text()).trimEnd().split('\r\n')
    expect(lines).toHaveLength(ACTIVITY_EXPORT_ROW_LIMIT + 1)
  })

  it('[api] an empty log is a header and nothing else', async () => {
    const { app } = harness('administrator', [])
    const lines = (await (await app.request('/api/v1/activity-log/export')).text()).trimEnd().split('\r\n')
    expect(lines).toHaveLength(1)
  })
})

describe('activity log CSV text', () => {
  it('[unit] neutralises a leading =, +, - or @ in any text field', () => {
    for (const lead of ['=', '+', '-', '@']) {
      const csv = renderActivityCsv(
        [entry(1, { actor: { type: 'user', id: 4, name: `${lead}HYPERLINK("x")` } })],
        false,
      )
      // The apostrophe goes before the guarded character, inside the quotes the comma/quote rule adds.
      expect(csv, lead).toContain(`'${lead}HYPERLINK`)
      expect(csv, lead).not.toMatch(new RegExp(`,"?${lead.replace(/[+]/u, '\\+')}HYPERLINK`, 'u'))
    }
  })

  it('[unit] neutralises the other text columns and a tab or return', () => {
    const csv = renderActivityCsv(
      [entry(1, { id: '=1+1', eventType: '+x', aggregateType: '@y', actor: { type: 'user', id: 4, name: '\tz' } })],
      false,
    )
    expect(csv).toContain("'=1+1,'+x")
    expect(csv).toContain(",'@y,")
    expect(csv).toContain("'\tz")
  })

  it('[unit] quotes commas, quotes and line breaks', () => {
    const csv = renderActivityCsv(
      [entry(1, { actor: { type: 'user', id: 4, name: 'Vale, "Robin"\nSmith' } })],
      false,
    )
    expect(csv).toContain('"Vale, ""Robin""\nSmith"')
  })
})
