/**
 * The BILL receivables surface an operator meets: whether this deployment can
 * reach BILL at all, and which clients are billed through it.
 *
 * There is no connect flow here, and its absence is the design. BILL has no
 * OAuth -- no authorization code, no consent screen -- so there is nothing for
 * a button to start. The credential is deployment configuration, set once, and
 * what an operator does on this screen is decide which clients it applies to.
 */

import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'

export interface BillStatus {
  readonly configured: boolean
  readonly organizationId: string | null
  readonly environment: 'sandbox' | 'production'
  /**
   * Whether this deployment's credential can have BILL send the invoice email.
   * A sync token cannot, and the screen has to say so -- an operator told
   * "BILL will email your client" when it will not is the difference between
   * the client getting one invoice and getting none.
   */
  readonly canSendFromBill: boolean
}

export interface BillService {
  status(): BillStatus
  /** Whether this client is billed through BILL. */
  isOptedIn(clientId: number): Promise<boolean>
  /** Returns false when no such client exists, so the route can answer 404. */
  setOptedIn(clientId: number, enabled: boolean): Promise<boolean>
}

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    // Sending a client's invoice through a third party changes how that client
    // is billed. It is not a preference a project manager sets in passing.
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can change how a client is billed.',
    })
  }
}

const clientId = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): number => {
  const raw = context.req.param('id') ?? ''
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw validationError([
      { field: 'id', code: 'invalid', message: 'id must be a positive integer.' },
    ])
  }
  return parsed
}

export const installBillRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<BillService>,
): void => {
  api.get('/integrations/bill', (context) => {
    assertAdministrator(context)
    const status = service.status()
    return context.json(
      {
        data: {
          configured: status.configured,
          organization_id: status.organizationId,
          environment: status.environment,
          can_send_from_bill: status.canSendFromBill,
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/integrations/bill/clients/:id', async (context) => {
    assertAdministrator(context)
    const id = clientId(context)
    return context.json(
      { data: { client_id: id, deliver_via_bill: await service.isOptedIn(id) } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/integrations/bill/clients/:id', async (context) => {
    assertAdministrator(context)
    const id = clientId(context)
    const body = await readObjectBody(context)
    const wanted = body['deliver_via_bill']
    if (typeof wanted !== 'boolean') {
      // A 422 has to name the field at fault -- the shape this codebase
      // enforces, because a validation error nobody can act on is a refusal.
      throw validationError([
        {
          field: 'deliver_via_bill',
          code: 'invalid',
          message: 'deliver_via_bill must be true or false.',
        },
      ])
    }
    if (!service.status().configured) {
      // Turning it on for a client this deployment cannot reach would be a
      // setting that looks saved and delivers nothing.
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'BILL is not configured for this deployment.',
      })
    }
    if (!(await service.setOptedIn(id, wanted))) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'That client does not exist.',
      })
    }
    return context.json(
      { data: { client_id: id, deliver_via_bill: wanted } },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
