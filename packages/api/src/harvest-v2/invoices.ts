import type { Hono } from 'hono'
import type { ApiContext } from '../context.js'
import { requireApiScope } from '../auth.js'
import { ApiError, validationError, type FieldError } from '../errors.js'
import { resourceId } from '../resources/support.js'
import { harvestInstant, harvestMoney } from './serializers.js'
import {
  harvestPage,
  harvestPageWindow,
  type HarvestPageRequest,
} from './pagination.js'

export interface HarvestInvoiceFilters {
  clientId?: number
  projectId?: number
  updatedSince?: string
  from?: string
  to?: string
  state?: 'draft' | 'open' | 'paid' | 'closed'
}
export interface HarvestInvoiceRecord {
  invoice: {
    id: number
    number: string
    subject: string | null
    purchase_order: string | null
    notes: string | null
    currency: string
    issue_date: string
    due_date: string
    payment_terms: string
    state: string
    sent_at: string | null
    paid_at: string | null
    paid_date: string | null
    closed_at: string | null
    period_start: string | null
    period_end: string | null
    retainer_id: number | null
    estimate_id: number | null
    recurring_invoice_id: number | null
    tax_rate_ppm: number | null
    tax2_rate_ppm: number | null
    discount_rate_ppm: number | null
    amount_cents: number
    due_amount_cents: number
    tax_amount_cents: number
    tax2_amount_cents: number
    discount_amount_cents: number
    payment_options: string[]
    created_at: string
    updated_at: string
    line_items: Array<{
      id: number
      kind: string
      description: string | null
      quantity: number
      unit_price_cents: number
      amount_cents: number
      taxed: boolean
      taxed2: boolean
      project_id: number | null
    }>
  }
  client: { id: number; name: string }
  creator: { id: number; name: string } | null
  projects: ReadonlyArray<{ id: number; name: string; code: string | null }>
}
export interface HarvestInvoiceSource {
  harvestInvoices(
    filters: Readonly<HarvestInvoiceFilters>,
    window: Readonly<{ offset: number; take: number }>,
  ): Promise<{ total: number; records: readonly HarvestInvoiceRecord[] }>
  harvestInvoice(id: number): Promise<HarvestInvoiceRecord | null>
}

const paymentTerms: Readonly<Record<string, string>> = {
  upon_receipt: 'upon receipt',
  net_15: 'net 15',
  net_30: 'net 30',
  net_45: 'net 45',
  net_60: 'net 60',
  custom: 'custom',
}
const harvestPaymentTerm = (value: string): string => {
  const result = Object.hasOwn(paymentTerms, value) ? paymentTerms[value] : undefined
  if (result === undefined) throw new Error('Unsupported invoice payment term')
  return result
}

const percentage = (ppm: number | null): number | null =>
  ppm === null ? null : ppm / 10_000
const instant = (value: string | null): string | null =>
  value === null ? null : harvestInstant(value)
export const serializeHarvestInvoice = ({
  invoice: r,
  client,
  creator,
  projects,
}: HarvestInvoiceRecord) => ({
  id: r.id,
  number: r.number,
  purchase_order: r.purchase_order,
  amount: harvestMoney(r.amount_cents),
  due_amount: harvestMoney(r.due_amount_cents),
  tax: percentage(r.tax_rate_ppm),
  tax_amount: harvestMoney(r.tax_amount_cents),
  tax2: percentage(r.tax2_rate_ppm),
  tax2_amount: harvestMoney(r.tax2_amount_cents),
  discount: percentage(r.discount_rate_ppm),
  discount_amount: harvestMoney(r.discount_amount_cents),
  subject: r.subject,
  notes: r.notes,
  state: r.state,
  period_start: r.period_start,
  period_end: r.period_end,
  issue_date: r.issue_date,
  due_date: r.due_date,
  payment_term: harvestPaymentTerm(r.payment_terms),
  sent_at: instant(r.sent_at),
  paid_at: instant(r.paid_at),
  paid_date: r.paid_date,
  closed_at: instant(r.closed_at),
  recurring_invoice_id: r.recurring_invoice_id,
  created_at: harvestInstant(r.created_at),
  updated_at: harvestInstant(r.updated_at),
  currency: r.currency,
  payment_options: [
    ...new Set(
      r.payment_options.flatMap((option) =>
        option === 'stripe_checkout'
          ? ['credit_card']
          : option === 'paypal_checkout'
            ? ['paypal']
            : [],
      ),
    ),
  ],
  client,
  estimate: r.estimate_id === null ? null : { id: r.estimate_id },
  retainer: r.retainer_id === null ? null : { id: r.retainer_id },
  creator,
  line_items: r.line_items.map((line) => ({
    id: line.id,
    kind: line.kind,
    description: line.description,
    quantity: line.quantity,
    unit_price: harvestMoney(line.unit_price_cents),
    amount: harvestMoney(line.amount_cents),
    taxed: line.taxed,
    taxed2: line.taxed2,
    project:
      line.project_id === null
        ? null
        : (() => {
            const project = projects.find(
              (project) => project.id === line.project_id,
            )
            if (!project)
              throw new Error('Harvest invoice line project is missing')
            return project
          })(),
  })),
})

export const parseHarvestInvoiceQuery = (
  params: URLSearchParams,
): {
  filters: HarvestInvoiceFilters
  page: HarvestPageRequest
  echo: Array<readonly [string, string]>
} => {
  const filters: HarvestInvoiceFilters = {},
    errors: FieldError[] = [],
    echo: Array<readonly [string, string]> = []
  const reject = (field: string) =>
    errors.push({ field, code: 'invalid', message: `Invalid ${field}.` })
  const number = (
    field: string,
    fallback: number,
    max = Number.MAX_SAFE_INTEGER,
  ): number => {
    const raw = params.get(field)
    if (raw === null) return fallback
    if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > max) {
      reject(field)
      return fallback
    }
    return Number(raw)
  }
  for (const [name, key] of [
    ['client_id', 'clientId'],
    ['project_id', 'projectId'],
  ] as const) {
    if (params.has(name)) {
      filters[key] = number(name, 1)
      echo.push([name, params.get(name)!])
    }
  }
  const state = params.get('state')
  if (state !== null) {
    echo.push(['state', state])
    if (['draft', 'open', 'paid', 'closed'].includes(state))
      filters.state = state as NonNullable<HarvestInvoiceFilters['state']>
    else reject('state')
  }
  for (const name of ['from', 'to'] as const) {
    const raw = params.get(name)
    if (raw !== null) {
      echo.push([name, raw])
      const ms = Date.parse(raw + 'T00:00:00.000Z')
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
        !Number.isFinite(ms) ||
        new Date(ms).toISOString().slice(0, 10) !== raw
      )
        reject(name)
      else filters[name] = raw
    }
  }
  const updated = params.get('updated_since')
  if (updated !== null) {
    echo.push(['updated_since', updated])
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(updated) ||
      !Number.isFinite(Date.parse(updated)) ||
      new Date(updated).toISOString().slice(0, 19) !== updated.slice(0, 19)
    )
      reject('updated_since')
    else filters.updatedSince = new Date(updated).toISOString()
  }
  if (filters.from && filters.to && filters.from > filters.to) reject('to')
  const page = {
    page: number('page', 1),
    perPage: number('per_page', 100, 2000),
  }
  if (errors.length) throw validationError(errors)
  return { filters, page, echo }
}

export const installHarvestInvoiceRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  source: HarvestInvoiceSource,
): void => {
  app.get('/invoices', async (context) => {
    requireApiScope(context, 'invoices:read')
    const { filters, page, echo } = parseHarvestInvoiceQuery(
      new URL(context.req.url).searchParams,
    )
    const result = await source.harvestInvoices(
      filters,
      harvestPageWindow(page),
    )
    return context.json(
      harvestPage(
        'invoices',
        result.records.map(serializeHarvestInvoice),
        result.total,
        page,
        '/harvest/v2/invoices',
        echo,
      ),
    )
  })
  app.get('/invoices/:id', async (context) => {
    requireApiScope(context, 'invoices:read')
    const record = await source.harvestInvoice(
      resourceId(context.req.param('id'), 'invoice'),
    )
    if (record === null)
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested invoice does not exist.',
      })
    return context.json(serializeHarvestInvoice(record))
  })
}
