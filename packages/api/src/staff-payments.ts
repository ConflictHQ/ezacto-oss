import {
  StaffPaymentError,
  validPaymentMonth,
  type StaffPaymentCommand,
  type StaffPaymentStore,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'

export const installStaffPaymentRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  store: StaffPaymentStore,
): void => {
  const invalid = (field: string, message: string): never => {
    throw validationError([{ field, code: 'invalid', message }])
  }
  api.use('/staff-payments', async (context, next) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can view staff payment records.',
      })
    await next()
  })
  api.use('/staff-payments/*', async (context, next) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can change staff payment records.',
      })
    await next()
  })
  api.get('/staff-payments', async (context) => {
    const month = context.req.query('month') ?? new Date().toISOString().slice(0, 7)
    if (!validPaymentMonth(month)) invalid('month', 'Choose a valid month (YYYY-MM).')
    return context.json(
      { data: await store.report(month, new Date().toISOString().slice(0, 10)) },
      200,
      { 'cache-control': 'no-store' },
    )
  })
  api.post('/staff-payments/events', async (context) => {
    const body = await readObjectBody(context)
    const string = (key: string): string =>
      typeof body[key] === 'string' ? (body[key] as string) : invalid(key, `${key} must be text.`)
    const nullableString = (key: string): string | null => (body[key] === null ? null : string(key))
    const integer = (key: string): number =>
      typeof body[key] === 'number' && Number.isSafeInteger(body[key])
        ? (body[key] as number)
        : invalid(key, `${key} must be an integer.`)
    const command: StaffPaymentCommand = {
      id: string('id'),
      user_id: integer('user_id'),
      month: string('month'),
      expected_version: integer('expected_version'),
      kind: string('kind') as StaffPaymentCommand['kind'],
      amount_cents: body.amount_cents === null ? null : integer('amount_cents'),
      currency: nullableString('currency'),
      paid_on: nullableString('paid_on'),
      due_on: nullableString('due_on'),
      reference: string('reference').trim(),
      note: string('note').trim(),
      payment_id: nullableString('payment_id'),
      source: string('source') as StaffPaymentCommand['source'],
    }
    if (command.user_id <= 0) invalid('user_id', 'Choose a person.')
    if (!validPaymentMonth(command.month)) invalid('month', 'Choose a valid month (YYYY-MM).')
    try {
      await store.append(
        command,
        requireSessionPrincipal(context).userId,
        context.get('requestId'),
        new Date().toISOString(),
      )
    } catch (error) {
      if (!(error instanceof StaffPaymentError)) throw error
      if (error.code === 'invalid') invalid('entry', error.message)
      throw new ApiError({
        status: error.code === 'not_found' ? 404 : 409,
        code: error.code,
        message: error.message,
      })
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
}
