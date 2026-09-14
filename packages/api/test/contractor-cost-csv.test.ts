import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { installReportRoutes } from '../src/reports.js'
import { errorResponse } from '../src/errors.js'

/**
 * Issue 280. The payroll run's output is pasted into another system, so the
 * artefact is the point -- "a copyable artefact matters more than a pretty
 * screen".
 */

const report = {
  from: '2026-08-01',
  to: '2026-08-31',
  rows: [
    {
      userId: 1,
      name: 'R. Adeyemi',
      payrollEmail: 'r.adeyemi@example.test',
      isContractor: true,
      currency: 'USD',
      roundedSeconds: 180_000,
      costCents: 500_000,
      costRateCents: 10_000,
      costRateIsMixed: false,
      entriesWithoutRate: 0,
    },
    {
      // A name that a spreadsheet would otherwise run as a formula, and one
      // carrying the delimiter.
      userId: 2,
      name: '=cmd|/c calc,Ltd',
      payrollEmail: null,
      isContractor: true,
      currency: 'USD',
      roundedSeconds: 3_600,
      costCents: null,
      // The rate moved inside the period as well as an entry lacking one, so
      // this row exercises both nulls at once.
      costRateCents: null,
      costRateIsMixed: true,
      entriesWithoutRate: 2,
    },
  ],
}

const app = (profile = 'administrator') => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId: 1,
      profile,
      scopes: ['reports:read'],
      authentication: { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installReportRoutes(instance as never, {
    contractorCost: async () => report,
  } as never)
  return instance as never as Hono<never>
}

const csv = async (query: string) => {
  const response = await app().request(`/reports/contractor?${query}`)
  return { response, body: await response.text() }
}

describe('the payroll run as a file', () => {
  it('[money] writes a row per person with hours and cost', async () => {
    const { response, body } = await csv('from=2026-08-01&to=2026-08-31&format=csv')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('content-disposition')).toContain(
      'contractor-cost-2026-08-01-to-2026-08-31.csv',
    )
    const lines = body.trimEnd().split('\n')
    expect(lines[0]).toBe(
      'user_id,name,payroll_email,is_contractor,currency,hours,cost_cents,cost_rate_cents,entries_without_rate',
    )
    // 180000 seconds is 50 hours.
    expect(lines[1]).toBe('1,R. Adeyemi,r.adeyemi@example.test,true,USD,50.00,500000,10000,0')
  })

  it('[money] leaves the cost empty when it could not be worked out', async () => {
    // Not 0.00. A payroll number that is silently wrong is worse than no
    // number, and a zero reads as "this person costs nothing".
    const { body } = await csv('from=2026-08-01&to=2026-08-31&format=csv')
    const row = body.trimEnd().split('\n')[2]!
    // Empty cost, then "mixed" rather than a blank rate: a rate that moved
    // inside the period is distinguishable from one that was never set, and
    // only one of those is somebody's mistake.
    expect(row.endsWith(',,mixed,2')).toBe(true)
    expect(row).not.toContain('0.00,0,')
  })

  it('[security] defuses a name a spreadsheet would run as a formula', async () => {
    // This file is opened by somebody about to pay people, and a name arrives
    // from whoever typed it.
    const { body } = await csv('from=2026-08-01&to=2026-08-31&format=csv')
    const row = body.trimEnd().split('\n')[2]!
    expect(row).toContain(`"'=cmd|/c calc,Ltd"`)
    expect(row.startsWith('2,=')).toBe(false)
  })

  it('[unit] ends with a newline, so appending cannot join two rows', async () => {
    const { body } = await csv('from=2026-08-01&to=2026-08-31&format=csv')
    expect(body.endsWith('\n')).toBe(true)
  })

  it('[api] still answers JSON without the parameter', async () => {
    const response = await app().request('/reports/contractor?from=2026-08-01&to=2026-08-31')
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as { data: { rows: unknown[] } }
    expect(body.data.rows).toHaveLength(2)
  })

  it('[api] refuses a format it cannot produce, rather than silently sending JSON', async () => {
    const response = await app().request(
      '/reports/contractor?from=2026-08-01&to=2026-08-31&format=pdf',
    )
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields.map((field) => field.field)).toEqual(['format'])
  })
})
