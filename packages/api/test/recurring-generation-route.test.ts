import { describe, expect, it } from 'vitest'
import {
  createApiApp,
  installMoneyResourceRoutes,
  type ApiAuthentication,
  type ApiTokenService,
  type MoneyResourceRouteOptions,
  type RecurringGenerationPort,
} from '../src/index.js'

type MoneyService = MoneyResourceRouteOptions['service']

// The route the engine was missing. `createRecurringInvoiceEngine` was written,
// tested and exported, and no runtime constructed it and no path called it, so
// a recurring definition sat at its next_issue_on date forever. These cover the
// seam: that the port is reached with the arguments it expects, and that the
// answers it gives arrive as distinguishable statuses rather than one 422.

const unavailable = () => {
  throw new Error('the recurring generation route does not reach this')
}

const authentication: ApiAuthentication = {
  tokens: new Proxy({}, { get: () => unavailable }) as ApiTokenService,
  sessions: {
    resolve: async () => ({
      type: 'user',
      userId: 7,
      profile: 'accounting',
      authentication: { kind: 'session', sessionId: 'recurring-test' },
    }),
  },
}

const invoice = { id: 91, number: 'INV-91' } as unknown as Awaited<
  ReturnType<MoneyService['getInvoice']>
>

const appWith = (port?: RecurringGenerationPort) =>
  createApiApp({
    authentication,
    installApi: (api) =>
      installMoneyResourceRoutes(api, {
        service: {
          getInvoice: async () => invoice,
        } as unknown as MoneyService,
        cursorSigningKey: new TextEncoder().encode(
          'recurring-generation-key-32-bytes',
        ),
        clock: () => '2026-09-09T12:00:00.000Z',
        ...(port === undefined ? {} : { recurringGeneration: port }),
      }),
  })

const post = (app: ReturnType<typeof appWith>, id = 3) =>
  app.request(`/api/v1/recurring-invoices/${id}/generations`, {
    method: 'POST',
    headers: {
      'idempotency-key': 'a'.repeat(36),
      // A session-authenticated mutation is refused cross-origin.
      origin: 'http://localhost',
    },
  })

describe('recurring invoice generation route', () => {
  it('[api] issues the invoice and reports where the cadence lands next', async () => {
    const calls: unknown[][] = []
    const response = await post(
      appWith({
        generate: async (definitionId, asOfDate, principal) => {
          calls.push([definitionId, asOfDate, principal])
          return {
            invoiceId: 91,
            definitionId,
            period: '2026-09',
            nextIssueOn: '2026-10-01',
            retainerDrawdownCents: null,
          }
        },
      }),
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      data: { generation: Record<string, unknown> }
    }
    expect(body.data.generation).toMatchObject({
      definition_id: 3,
      period: '2026-09',
      next_issue_on: '2026-10-01',
    })
    // A date, not a timestamp, and the acting principal rather than a fixed
    // one -- the engine refuses a caller whose profile does not match. The tag
    // is what the engine records as the ledger's actor_type, and a route is
    // always a user: the only writer that is not comes from the cron.
    expect(calls).toEqual([
      [3, '2026-09-09', { type: 'user', userId: 7, profile: 'accounting' }],
    ])
  })

  it('[api] answers 409, not 422, when the definition is not due yet', async () => {
    // The caller asked early. That is a different thing from a malformed
    // request, and collapsing them into one status is what makes an operator
    // think the definition is broken.
    const response = await post(
      appWith({
        generate: async () => {
          throw Object.assign(new Error('definition 3 is not due until 2026-10-01'), {
            code: 'not_due',
          })
        },
      }),
    )

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_due')
    // The date is the actionable part, so it has to survive into the message.
    expect(body.error.message).toContain('2026-10-01')
  })

  it('[api] answers 404 for a definition that does not exist', async () => {
    const response = await post(
      appWith({
        generate: async () => {
          throw Object.assign(new Error('recurring invoice definition 3 does not exist'), {
            code: 'definition_not_found',
          })
        },
      }),
    )

    expect(response.status).toBe(404)
  })

  it('[api] answers 409 when this period was already generated', async () => {
    const response = await post(
      appWith({
        generate: async () => {
          throw Object.assign(new Error('recurring generation command is in progress'), {
            code: 'already_generated',
          })
        },
      }),
    )

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('already_generated')
  })

  it('[api] answers 503 where the deployment supplies no engine', async () => {
    // Rather than 404, which would read as "no such definition" and send an
    // operator looking for the wrong problem.
    const response = await post(appWith(undefined))

    expect(response.status).toBe(503)
    // The status is the whole answer. `errorResponse` gives every 5xx a generic
    // code and message on purpose, so nothing about the deployment's shape
    // leaks; asserting the status here is asserting that policy too.
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('internal_error')
  })
})
