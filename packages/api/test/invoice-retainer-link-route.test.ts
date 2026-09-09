import { describe, expect, it } from 'vitest'
import {
  createApiApp,
  installMoneyResourceRoutes,
  type ApiAuthentication,
  type ApiTokenService,
  type MoneyResourceRouteOptions,
} from '../src/index.js'

type MoneyService = MoneyResourceRouteOptions['service']

// The field the schema was waiting for. `retainer_ledger` refuses a deposit or
// a drawdown whose invoice is not linked to the same retainer, and no route
// wrote `invoices.retainer_id` -- so a retainer could be created, listed and
// opened, and never moved. These cover the route seam: that the field arrives
// as an edit, and that a body naming nothing else is still a real edit.

const unavailable = () => {
  throw new Error('the invoice edit route does not reach this')
}

const authentication: ApiAuthentication = {
  tokens: new Proxy({}, { get: () => unavailable }) as ApiTokenService,
  sessions: {
    resolve: async () => ({
      type: 'user',
      userId: 7,
      profile: 'accounting',
      authentication: { kind: 'session', sessionId: 'retainer-link-test' },
    }),
  },
}

const invoice = { id: 5, number: 'INV-5' } as unknown as Awaited<
  ReturnType<MoneyService['getInvoice']>
>

const appWith = (edits: unknown[]) =>
  createApiApp({
    authentication,
    installApi: (api) =>
      installMoneyResourceRoutes(api, {
        service: {
          getInvoice: async () => invoice,
          executeEdit: async (command: unknown) => {
            edits.push(command)
            return {
              schema_version: 1,
              event_ids: ['evt'],
              first_aggregate_sequence: 1,
              event_count: 1,
              invoice: { id: 5, version: 1 },
            }
          },
        } as unknown as MoneyService,
        cursorSigningKey: new TextEncoder().encode('retainer-link-key-32-bytes-long!'),
        clock: () => '2026-09-09T12:00:00.000Z',
      }),
  })

const patch = (app: ReturnType<typeof appWith>, body: Record<string, unknown>) =>
  app.request('/api/v1/invoices/5', {
    method: 'PATCH',
    headers: {
      'idempotency-key': 'a'.repeat(36),
      'content-type': 'application/json',
      // A session-authenticated mutation is refused cross-origin.
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  })

describe('linking an invoice to a retainer', () => {
  it('[api] carries retainer_id through as a header edit', async () => {
    const edits: unknown[] = []
    const response = await patch(appWith(edits), { expected_version: 0, retainer_id: 3 })

    expect(response.status).toBe(200)
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({
      invoiceId: 5,
      expectedVersion: 0,
      edit: { type: 'header', retainerId: 3 },
    })
  })

  it('[api] accepts retainer_id alone as a whole edit', async () => {
    // A body carrying nothing but the link is the ordinary case -- it is what
    // "put this invoice on that retainer" looks like -- and rejecting it as an
    // empty edit would leave the feature reachable only alongside another change.
    const edits: unknown[] = []
    const response = await patch(appWith(edits), { expected_version: 2, retainer_id: null })

    expect(response.status).toBe(200)
    expect(edits[0]).toMatchObject({ edit: { type: 'header', retainerId: null } })
  })

  it('[api] refuses a retainer_id that is not a positive id', async () => {
    const response = await patch(appWith([]), { expected_version: 0, retainer_id: 0 })

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields.map((field) => field.field)).toContain('retainer_id')
  })

  it('[api] will not mix the link with a financial edit', async () => {
    // The route applies exactly one kind of edit per command, so a body that
    // straddles two is a request nobody can predict the result of.
    const response = await patch(appWith([]), {
      expected_version: 0,
      retainer_id: 3,
      tax_rate_ppm: 1000,
    })

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { code: string }[] } }
    expect(body.error.fields.map((field) => field.code)).toContain('one_edit_kind')
  })
})
