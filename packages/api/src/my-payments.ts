import { previousPaymentMonth, validPaymentMonth, type MyPaymentsStore } from '@ezacto/core'
import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

/**
 * Issue 100 (docs/contractor-payments.md): a person's own payment summary.
 *
 * The subject is the authenticated user and nothing else. The route has no
 * person parameter and ignores any query parameter that tries to name one, so
 * there is no input an attacker can change to read somebody else's pay.
 */
export const installMyPaymentRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  store: MyPaymentsStore,
): void => {
  api.get('/me/payments', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.ownMoneyVisible !== true)
      throw new ApiError({
        status: 403,
        code: 'own_money_disabled',
        message: 'This organization has not enabled people viewing their own money.',
      })
    const now = new Date().toISOString()
    const month = context.req.query('month') ?? previousPaymentMonth(now)
    if (!validPaymentMonth(month))
      throw validationError([{ field: 'month', code: 'invalid', message: 'Choose a valid month (YYYY-MM).' }])
    const data = await store.read(principal.userId, month, now.slice(0, 10))
    if (data === null)
      throw new ApiError({
        status: 403,
        code: 'not_a_payee',
        message: 'No payments are recorded for you.',
      })
    return context.json({ data }, 200, { 'cache-control': 'no-store' })
  })
}
