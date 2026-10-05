import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  installInvoiceHoursReportRoutes,
  type InvoiceHoursReport,
} from '../src/invoice-hours-report.js'

/**
 * Issue 647. The work journal as a download. The rendering is core's and the
 * note rule is the store's -- both tested against the real thing there and in
 * the Worker's runtime test -- so what is pinned here is the route's own
 * contract: who may read it, what it answers, and what the file is called.
 */

const report = (overrides: Partial<InvoiceHoursReport> = {}): InvoiceHoursReport => ({
  invoiceNumber: '1315',
  companyName: 'CONFLICT',
  clientName: 'Kestrel Environmental',
  level: null,
  entries: [
    {
      spentDate: '2026-08-03',
      personName: 'R. Adeyemi',
      clientName: 'Kestrel Environmental',
      projectName: 'Phase 1',
      projectCode: '',
      taskName: 'Advisory',
      roles: [],
      notes: 'Reviewed the forecast model',
      seconds: 5_400,
      billable: true,
    },
  ],
  ...overrides,
})

type Authentication =
  | { kind: 'session'; sessionId: string }
  | { kind: 'token'; tokenId: number; scopes: string[] }

const app = (
  options: {
    read?: (invoiceId: number) => Promise<InvoiceHoursReport | null>
    profile?: string
    authentication?: Authentication
  } = {},
) => {
  const readHoursReport = vi.fn(options.read ?? (async () => report()))
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId: 1,
      profile: options.profile ?? 'administrator',
      authentication: options.authentication ?? { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installInvoiceHoursReportRoutes(instance as never, { readHoursReport })
  return { request: (path: string) => instance.request(path), readHoursReport }
}

const fields = async (response: Response): Promise<string[]> =>
  ((await response.json()) as { error: { fields: { field: string }[] } }).error.fields.map(
    (field) => field.field,
  )

describe('downloading the hours an invoice billed', () => {
  it('[unit] answers each format as an attachment named for the invoice', async () => {
    const { request } = app()
    for (const [format, type, magic] of [
      ['pdf', 'application/pdf', [0x25, 0x50, 0x44, 0x46]],
      ['csv', 'text/csv; charset=utf-8', [0xef, 0xbb, 0xbf]],
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', [0x50, 0x4b, 0x03, 0x04]],
    ] as const) {
      const response = await request(`/invoices/1315/hours-report?format=${format}&detail=detailed`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(type)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="work-detailed-1315.${format}"; filename*=UTF-8''work-detailed-1315.${format}`,
      )
      const bytes = new Uint8Array(await response.arrayBuffer())
      expect(Array.from(bytes.slice(0, magic.length))).toEqual(magic)
      expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    }
  })

  it('[unit] reads the invoice the path names', async () => {
    const { request, readHoursReport } = app()
    await request('/invoices/77/hours-report?format=csv')
    expect(readHoursReport).toHaveBeenCalledWith(77)
  })

  it('[money] renders the level asked for', async () => {
    const { request } = app({ read: async () => report({ level: 'detailed' }) })
    const response = await request('/invoices/1315/hours-report?format=csv&detail=summary')
    expect(response.headers.get('content-disposition')).toContain('work-summary-1315.csv')
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain('Project,Entries,Hours')
  })

  it("[money] defaults to the invoice's own journal level, and to detailed when it has none", async () => {
    const summary = app({ read: async () => report({ level: 'summary' }) })
    expect(
      (await summary.request('/invoices/1315/hours-report?format=pdf')).headers.get('content-disposition'),
    ).toContain('work-summary-1315.pdf')
    const off = app({ read: async () => report({ level: null }) })
    expect(
      (await off.request('/invoices/1315/hours-report?format=pdf')).headers.get('content-disposition'),
    ).toContain('work-detailed-1315.pdf')
  })

  it('[security] names the file safely whatever the invoice number holds', async () => {
    const { request } = app({ read: async () => report({ invoiceNumber: '2026/09 "Ä"' }) })
    expect(
      (await request('/invoices/1315/hours-report?format=csv')).headers.get('content-disposition'),
    ).toBe(
      `attachment; filename="work-detailed-2026-09----.csv"; filename*=UTF-8''work-detailed-2026-09----.csv`,
    )
  })

  it('[api] answers 404 for an invoice that does not exist', async () => {
    const { request } = app({ read: async () => null })
    const response = await request('/invoices/404/hours-report?format=pdf')
    expect(response.status).toBe(404)
  })

  it('[api] answers 409 for an invoice that billed no time, rather than an empty report', async () => {
    const { request } = app({ read: async () => report({ entries: [] }) })
    const response = await request('/invoices/1315/hours-report?format=xlsx')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'no_billed_time',
        message: 'This invoice has billed no time entries, so there is no hours report to download.',
      },
    })
  })

  it('[api] answers 422 naming each parameter at fault, and reads nothing', async () => {
    for (const [query, expected] of [
      ['', ['format']],
      ['?format=docx', ['format']],
      ['?format=PDF', ['format']],
      ['?format=pdf&detail=everything', ['detail']],
      ['?format=pdf&grain=entry', ['grain']],
      ['?format=pdf&format=csv', ['format']],
      ['?format=csv&detail=summary&detail=detailed', ['detail']],
    ] as const) {
      const { request, readHoursReport } = app()
      const response = await request(`/invoices/1315/hours-report${query}`)
      expect(response.status).toBe(422)
      expect(await fields(response)).toEqual(expected)
      expect(readHoursReport).not.toHaveBeenCalled()
    }
    for (const id of ['0', '-1', 'abc', '1.5']) {
      const { request, readHoursReport } = app()
      const response = await request(`/invoices/${id}/hours-report?format=pdf`)
      expect(response.status).toBe(422)
      expect(await fields(response)).toEqual(['id'])
      expect(readHoursReport).not.toHaveBeenCalled()
    }
  })
})

describe('who may download it', () => {
  it('[security] admits the profiles that read invoices, by session', async () => {
    for (const profile of ['administrator', 'accounting', 'executive_manager']) {
      const { request } = app({ profile })
      expect((await request('/invoices/1315/hours-report?format=pdf')).status).toBe(200)
    }
  })

  it('[security] refuses a profile that cannot read invoices, before reading anything', async () => {
    for (const profile of ['member', 'project_manager', 'people_admin']) {
      const { request, readHoursReport } = app({ profile })
      const response = await request('/invoices/1315/hours-report?format=pdf')
      expect(response.status).toBe(403)
      expect(readHoursReport).not.toHaveBeenCalled()
    }
  })

  it('[security] takes a token only when it grants invoices:read', async () => {
    const granted = app({
      authentication: { kind: 'token', tokenId: 1, scopes: ['invoices:read'] },
    })
    expect((await granted.request('/invoices/1315/hours-report?format=csv')).status).toBe(200)
    const refused = app({
      authentication: { kind: 'token', tokenId: 2, scopes: ['reports:read', 'time_entries:read'] },
    })
    const response = await refused.request('/invoices/1315/hours-report?format=csv')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'insufficient_scope' } })
    expect(refused.readHoursReport).not.toHaveBeenCalled()
  })
})
