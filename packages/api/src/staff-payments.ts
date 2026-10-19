import {
  StaffPaymentError,
  type AllocatePayment,
  type ReversePaymentAllocation,
  previousPaymentMonth,
  type ConfirmPaymentActuals,
  validPaymentMonth,
  type StaffPaymentCommand,
  type StaffPaymentProviderCommand,
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
    const month = context.req.query('month') ?? previousPaymentMonth(new Date().toISOString())
    if (!validPaymentMonth(month)) invalid('month', 'Choose a valid month (YYYY-MM).')
    return context.json(
      {
        data: await store.report(month, new Date().toISOString().slice(0, 10)),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
  const actualsError = (error: unknown): never => {
    if (!(error instanceof StaffPaymentError)) throw error
    if (error.code === 'invalid') invalid('actuals', error.message)
    throw new ApiError({
      status: error.code === 'not_found' ? 404 : 409,
      code: error.code,
      message: error.message,
    })
  }
  api.get('/staff-payments/actuals', async (context) => {
    const month = context.req.query('month') ?? previousPaymentMonth(new Date().toISOString())
    if (!validPaymentMonth(month)) invalid('month', 'Choose a valid work month.')
    if (!store.actuals)
      throw new ApiError({
        status: 503,
        code: 'unavailable',
        message: 'Actuals are unavailable.',
      })
    try {
      return context.json(
        { data: await store.actuals(month, new Date().toISOString()) },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return actualsError(error)
    }
  })
  api.post('/staff-payments/actuals', async (context) => {
    const body = await readObjectBody(context)
    if (
      typeof body.id !== 'string' ||
      typeof body.month !== 'string' ||
      typeof body.note !== 'string' ||
      typeof body.currency !== 'string' ||
      typeof body.user_id !== 'number' ||
      typeof body.expected_version !== 'number' ||
      !Array.isArray(body.entries) ||
      body.entries.some((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return true
        const e = entry as Record<string, unknown>
        return (
          ['entry_id', 'project_id', 'rounded_seconds', 'selected_seconds'].some(
            (key) => typeof e[key] !== 'number',
          ) ||
          (e.cost_rate_cents !== null && typeof e.cost_rate_cents !== 'number') ||
          typeof e.spent_date !== 'string' ||
          typeof e.project_name !== 'string'
        )
      })
    )
      invalid('actuals', 'Provide valid actual time entries and a review explanation.')
    if (!store.confirmActuals)
      throw new ApiError({
        status: 503,
        code: 'unavailable',
        message: 'Actuals are unavailable.',
      })
    const command: ConfirmPaymentActuals = {
      id: body.id as string,
      user_id: body.user_id as number,
      month: body.month as string,
      expected_version: body.expected_version as number,
      currency: body.currency as string,
      entries: body.entries as ConfirmPaymentActuals['entries'],
      note: body.note as string,
    }
    try {
      await store.confirmActuals(
        command,
        requireSessionPrincipal(context).userId,
        context.get('requestId'),
        new Date().toISOString(),
      )
    } catch (error) {
      return actualsError(error)
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
  const allocationError = (error: unknown): never => {
    if (!(error instanceof StaffPaymentError)) throw error
    if (error.code === 'invalid') invalid('allocation', error.message)
    throw new ApiError({
      status: error.code === 'not_found' ? 404 : 409,
      code: error.code,
      message: error.message,
    })
  }
  const allocationCommand = (body: Record<string, unknown>): AllocatePayment => {
    const text = (key: string): string =>
      typeof body[key] === 'string' ? (body[key] as string) : invalid(key, `${key} must be text.`)
    const nullableInteger = (key: string): number | null =>
      body[key] === null || body[key] === undefined
        ? null
        : typeof body[key] === 'number' && Number.isSafeInteger(body[key])
          ? (body[key] as number)
          : invalid(key, `${key} must be an integer or null.`)
    return {
      id: text('id'),
      payment_kind: text('payment_kind') as AllocatePayment['payment_kind'],
      payment_id: text('payment_id'),
      user_id: nullableInteger('user_id') ?? invalid('user_id', 'Choose a person.'),
      month: text('month'),
      scope: text('scope') as AllocatePayment['scope'],
      project_id: nullableInteger('project_id'),
      entry_id: nullableInteger('entry_id'),
      seconds: nullableInteger('seconds'),
      amount_cents: nullableInteger('amount_cents'),
      reason: text('reason'),
    }
  }
  const unavailable = (): never => {
    throw new ApiError({ status: 503, code: 'unavailable', message: 'Payment allocation is unavailable.' })
  }
  api.get('/staff-payments/allocations', async (context) => {
    const month = context.req.query('month') ?? previousPaymentMonth(new Date().toISOString())
    if (!validPaymentMonth(month)) invalid('month', 'Choose a valid work month.')
    if (!store.allocationReport) return unavailable()
    return context.json({ data: await store.allocationReport(month) }, 200, { 'cache-control': 'no-store' })
  })
  api.post('/staff-payments/allocations/preview', async (context) => {
    const command = allocationCommand(await readObjectBody(context))
    if (!store.previewAllocation) return unavailable()
    try {
      return context.json({ data: await store.previewAllocation(command) }, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return allocationError(error)
    }
  })
  api.post('/staff-payments/allocations', async (context) => {
    const command = allocationCommand(await readObjectBody(context))
    if (!store.allocatePayment) return unavailable()
    try {
      await store.allocatePayment(command, requireSessionPrincipal(context).userId, context.get('requestId'), new Date().toISOString())
    } catch (error) {
      return allocationError(error)
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
  api.post('/staff-payments/allocations/reversals', async (context) => {
    const body = await readObjectBody(context)
    if (typeof body.id !== 'string' || typeof body.allocation_id !== 'string' || typeof body.reason !== 'string')
      invalid('reversal', 'Provide a reversal identifier, an allocation and a reason.')
    const command: ReversePaymentAllocation = {
      id: body.id as string,
      allocation_id: body.allocation_id as string,
      reason: body.reason as string,
    }
    if (!store.reverseAllocation) return unavailable()
    try {
      await store.reverseAllocation(command, requireSessionPrincipal(context).userId, context.get('requestId'), new Date().toISOString())
    } catch (error) {
      return allocationError(error)
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
  api.post('/staff-payments/provider-settings', async (context) => {
    const body = await readObjectBody(context)
    if (
      typeof body.id !== 'string' ||
      typeof body.note !== 'string' ||
      typeof body.expected_version !== 'number' ||
      (body.user_id !== null && typeof body.user_id !== 'number') ||
      (body.provider !== null && body.provider !== 'wise' && body.provider !== 'deel')
    )
      invalid('settings', 'Provide a valid provider setting, version, person and note.')
    const command: StaffPaymentProviderCommand = {
      id: body.id as string,
      user_id: body.user_id as number | null,
      expected_version: body.expected_version as number,
      provider: body.provider as StaffPaymentProviderCommand['provider'],
      note: (body.note as string).trim(),
    }
    try {
      await store.configureProvider(
        command,
        requireSessionPrincipal(context).userId,
        context.get('requestId'),
        new Date().toISOString(),
      )
    } catch (error) {
      if (!(error instanceof StaffPaymentError)) throw error
      if (error.code === 'invalid') invalid('settings', error.message)
      throw new ApiError({
        status: error.code === 'not_found' ? 404 : 409,
        code: error.code,
        message: error.message,
      })
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
  api.post('/staff-payments/events', async (context) => {
    const body = await readObjectBody(context)
    const string = (key: string): string =>
      typeof body[key] === 'string'
        ? (body[key] as string)
        : invalid(key, `${key} must be text.`)
    const nullableString = (key: string): string | null =>
      body[key] === null ? null : string(key)
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
