import type { Context, Hono } from 'hono'
import {
  StaffPaymentError,
  previousPaymentMonth,
  validPaymentMonth,
  type ContractorReviewStore,
  type AcceptContractorReview,
} from '@ezacto/core'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { bodyLimit } from 'hono/body-limit'
import { readObjectBody } from './resources/support.js'
const administrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
) => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator')
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can review contractor payment records.',
    })
  context.header('cache-control', 'no-store')
  return principal
}
const failure = (error: unknown): never => {
  if (!(error instanceof StaffPaymentError)) throw error
  if (error.code === 'invalid')
    throw validationError([
      { field: 'review', code: 'invalid', message: error.message },
    ])
  throw new ApiError({
    status: error.code === 'not_found' ? 404 : 409,
    code: error.code,
    message: error.message,
  })
}

export const installContractorReviewRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  store: ContractorReviewStore,
  clock: () => string = () => new Date().toISOString(),
): void => {
  api.get('/staff-payments/contractor-review', async (context) => {
    administrator(context)
    const now = clock(),
      month = context.req.query('month') ?? previousPaymentMonth(now)
    if (!validPaymentMonth(month))
      throw validationError([
        {
          field: 'month',
          code: 'invalid',
          message: 'Choose a valid work month.',
        },
      ])
    try {
      return context.json({ data: await store.review(month, now) }, 200, {
        'cache-control': 'no-store',
      })
    } catch (error) {
      failure(error)
    }
  })
  if (store.acceptances)
    api.get(
      '/staff-payments/contractor-review/acceptances',
      async (context) => {
        administrator(context)
        const month =
          context.req.query('month') ?? previousPaymentMonth(clock())
        try {
          return context.json({ data: await store.acceptances!(month) })
        } catch (error) {
          failure(error)
        }
      },
    )
  api.use(
    '/staff-payments/contractor-review/acceptances',
    bodyLimit({
      maxSize: 8192,
      onError: () => {
        throw new ApiError({
          status: 413,
          code: 'payload_too_large',
          message: 'The confirmation is too large.',
        })
      },
    }),
  )
  if (store.accept)
    api.post(
      '/staff-payments/contractor-review/acceptances',
      async (context) => {
        const principal = administrator(context)
        const body = await readObjectBody(context)
        const strings = [
          'id',
          'month',
          'currency',
          'review_version',
          'source_revision',
          'reason',
        ]
        const allowed = [
          ...strings,
          'user_id',
          'apply_allocations',
          'apply_credits',
        ]
        if (
          Object.keys(body).some((key) => !allowed.includes(key)) ||
          strings.some((key) => typeof body[key] !== 'string') ||
          typeof body.user_id !== 'number' ||
          typeof body.apply_allocations !== 'boolean' ||
          typeof body.apply_credits !== 'boolean'
        )
          throw validationError([
            {
              field: 'review',
              code: 'invalid',
              message:
                'Provide the displayed review, selected changes and a reason.',
            },
          ])
        try {
          return context.json(
            {
              data: await store.accept!(
                body as unknown as AcceptContractorReview,
                principal.userId,
                context.get('requestId'),
                clock(),
              ),
            },
            200,
          )
        } catch (error) {
          failure(error)
        }
      },
    )
}
