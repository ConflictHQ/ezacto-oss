import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError, type FieldError } from './errors.js'

/**
 * Invoices › Configure, as Harvest had it: the company information every invoice
 * prints (name, address) and the default values a new draft starts with (notes,
 * subject). The notes are where the beneficiary and bank details live, so an
 * install without them sends invoices nobody can pay without asking.
 */

export interface InvoiceDefaultsBody {
  readonly companyName: string
  readonly companyAddress: string | null
  readonly notes: string | null
  readonly subject: string | null
  readonly estimateValidityDays: number | null
}

export interface InvoiceDefaultsService {
  read(): Promise<InvoiceDefaultsBody>
  update(patch: Partial<InvoiceDefaultsBody>): Promise<InvoiceDefaultsBody>
}

const assertMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can change invoice settings.',
    })
  }
}

const fields = [
  { key: 'company_name', name: 'companyName', max: 255, nullable: false },
  { key: 'company_address', name: 'companyAddress', max: 2000, nullable: true },
  { key: 'notes', name: 'notes', max: 100_000, nullable: true },
  { key: 'subject', name: 'subject', max: 998, nullable: true },
] as const

/** Every field read before any is written, so one bad field changes nothing. */
const patchOf = (body: Record<string, unknown>): Partial<InvoiceDefaultsBody> => {
  const errors: FieldError[] = []
  const patch: Record<string, string | number | null> = {}
  for (const key of Object.keys(body)) {
    if (key !== 'estimate_validity_days' && !fields.some((field) => field.key === key)) {
      errors.push({ field: key, code: 'unknown', message: `${key} is not an invoice setting.` })
    }
  }
  if ('estimate_validity_days' in body) {
    const days = body['estimate_validity_days']
    if (days === null) {
      patch['estimateValidityDays'] = null
    } else if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 3650) {
      errors.push({
        field: 'estimate_validity_days',
        code: 'invalid',
        message:
          'estimate_validity_days must be a whole number of days from 1 to 3650, or null for estimates that do not expire.',
      })
    } else {
      patch['estimateValidityDays'] = days as number
    }
  }
  for (const field of fields) {
    if (!(field.key in body)) continue
    const value = body[field.key]
    if (value === null && field.nullable) {
      patch[field.name] = null
    } else if (typeof value !== 'string' || value.length > field.max) {
      errors.push({
        field: field.key,
        code: 'invalid',
        message: `${field.key} must be text of at most ${String(field.max)} characters${field.nullable ? ', or null for none' : ''}.`,
      })
    } else if (!field.nullable && value.trim() === '') {
      errors.push({ field: field.key, code: 'required', message: `${field.key} cannot be blank.` })
    } else {
      patch[field.name] = value
    }
  }
  if (errors.length > 0) throw validationError(errors)
  if (Object.keys(patch).length === 0) {
    throw validationError([
      {
        field: 'company_name',
        code: 'required',
        message:
          'Provide company_name, company_address, notes, subject, estimate_validity_days, or any combination.',
      },
    ])
  }
  return patch as Partial<InvoiceDefaultsBody>
}

const envelope = (defaults: InvoiceDefaultsBody) => ({
  data: {
    company_name: defaults.companyName,
    company_address: defaults.companyAddress,
    notes: defaults.notes,
    subject: defaults.subject,
    estimate_validity_days: defaults.estimateValidityDays,
  },
})

export const installInvoiceDefaultsRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceDefaultsService>,
): void => {
  api.get('/settings/invoice-defaults', async (context) => {
    assertMoneyWriter(context)
    return context.json(envelope(await service.read()), 200, { 'cache-control': 'no-store' })
  })

  api.post('/settings/invoice-defaults', async (context) => {
    assertMoneyWriter(context)
    const raw: unknown = await context.req.json().catch(() => null)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw validationError([
        { field: 'body', code: 'invalid', message: 'The request body must be a JSON object.' },
      ])
    }
    const updated = await service.update(patchOf(raw as Record<string, unknown>))
    return context.json(envelope(updated), 200, { 'cache-control': 'no-store' })
  })
}
