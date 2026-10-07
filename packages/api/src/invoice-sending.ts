/**
 * Who an invoice email goes to and what it carries, as standing rules.
 *
 * The Send dialog used to start empty every month. These routes are what it
 * opens on instead: the client's own To and Cc lists -- or, until it has
 * saved some, its contacts' invoice routing, which is how Harvest kept the
 * same answer -- the organization's mailboxes copied on every invoice email,
 * whether the person sending is copied, and the subject and message the
 * organization's invoice template starts the email with.
 *
 * A client's sending profile is also where its attachment rules live: an
 * accounts payable department that wants the purchase order bound into the
 * back of every invoice wants it on every invoice, not remembered by whoever
 * sends this month's. An invoice's own answer still wins, and the
 * organization's answers anything neither has.
 */

import {
  InvoiceAddressError,
  normalizeInvoiceAddresses,
  normalizeInvoiceRecipientLists,
  parseJournalFormats,
  type InvoiceAddress,
  type JournalFormat,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError, type FieldError } from './errors.js'
import { invoiceEmailReadiness, type InvoiceEmailReadinessPorts } from './money-resources.js'

export type JournalLevelPreference = 'detailed' | 'summary' | false

/** A client's attachment rules; `null` follows the organization. */
export interface ClientAttachmentRules {
  readonly attachPdf: boolean | null
  readonly appendPdfs: boolean | null
  readonly attachFiles: boolean | null
  readonly attachJournal: JournalLevelPreference | null
  readonly journalFormats: readonly JournalFormat[] | null
}

export interface OrganizationAttachmentRules {
  readonly attachPdf: boolean
  readonly appendPdfs: boolean
  readonly attachFiles: boolean
  readonly attachJournal: JournalLevelPreference
  readonly journalFormats: readonly JournalFormat[]
}

export interface ClientInvoiceSending {
  readonly clientId: number
  /** What the client saved, or `null` where it follows its contacts. */
  readonly recipients: { readonly to: readonly InvoiceAddress[]; readonly cc: readonly InvoiceAddress[] } | null
  /** The contacts' invoice routing: Recipient is To, CC is Cc. */
  readonly contacts: { readonly to: readonly InvoiceAddress[]; readonly cc: readonly InvoiceAddress[] }
  readonly rules: ClientAttachmentRules
  readonly organization: OrganizationAttachmentRules
}

export interface ClientInvoiceSendingChange {
  readonly recipients?: { readonly to: readonly InvoiceAddress[]; readonly cc: readonly InvoiceAddress[] } | null
  readonly rules?: Partial<ClientAttachmentRules>
}

export interface InvoiceEmailDefaults {
  readonly invoiceId: number
  readonly clientId: number
  readonly companyName: string
  readonly clientName: string
  readonly templateVersion: number
  /** The organization's invoice template, as the dialog's starting point. */
  readonly subject: string
  readonly message: string
  readonly to: readonly InvoiceAddress[]
  readonly cc: readonly InvoiceAddress[]
  readonly recipientsSource: 'client' | 'contacts'
  readonly alwaysCc: readonly InvoiceAddress[]
  /** The person asking: where a copy would go, and whether they want one. */
  readonly sender: { readonly name: string; readonly email: string | null }
  readonly sendMeACopy: boolean
}

export interface InvoiceSendingService {
  emailDefaults(invoiceId: number, userId: number): Promise<InvoiceEmailDefaults | null>
  readClientSending(clientId: number): Promise<ClientInvoiceSending | null>
  saveClientSending(
    clientId: number,
    change: ClientInvoiceSendingChange,
    updatedAt: string,
  ): Promise<ClientInvoiceSending | null>
  readAlwaysCc(): Promise<readonly InvoiceAddress[]>
  saveAlwaysCc(addresses: readonly InvoiceAddress[]): Promise<readonly InvoiceAddress[]>
}

export interface InvoiceSendingRouteOptions {
  readonly service: InvoiceSendingService
  readonly clock?: () => string
  /**
   * The mail the invoice email would leave through, so the dialog's defaults
   * can say whether it can leave at all. Absent where the deployment composes
   * no organization mail, which the dialog is told as the refusal a send
   * would meet.
   */
  readonly delivery?: InvoiceEmailReadinessPorts
}

/**
 * Who may set what a client's invoices carry and who they reach: the people
 * who raise invoices, as for the attachments an invoice carries.
 */
const assertMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): number => {
  const principal = requireSessionPrincipal(context)
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can change how invoices are sent.',
    })
  }
  return principal.userId
}

const positiveId = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  name: string,
): number => {
  const id = Number(context.req.param('id') ?? '')
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw validationError([
      { field: 'id', code: 'invalid', message: `${name} id must be a positive integer.` },
    ])
  }
  return id
}

const notFound = (what: string) =>
  new ApiError({ status: 404, code: 'not_found', message: `The ${what} does not exist.` })

const objectBody = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<Record<string, unknown>> => {
  const body = (await context.req.json().catch(() => null)) as unknown
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([
      { field: 'body', code: 'invalid_object', message: 'body must be a JSON object' },
    ])
  }
  return body as Record<string, unknown>
}

const addresses = (value: unknown): InvoiceAddress[] | null =>
  Array.isArray(value) ? (value as InvoiceAddress[]) : null

/** Address errors become field errors naming the entry the caller got wrong. */
const asFieldError = (error: unknown): never => {
  if (error instanceof InvoiceAddressError) {
    throw validationError([{ field: error.field, code: 'invalid_address', message: error.message }])
  }
  throw error
}

const addressData = (list: readonly InvoiceAddress[]) => list.map(({ name, email }) => ({ name, email }))

const sendingData = (sending: ClientInvoiceSending) => ({
  client_id: sending.clientId,
  recipients:
    sending.recipients === null
      ? null
      : { to: addressData(sending.recipients.to), cc: addressData(sending.recipients.cc) },
  contacts: { to: addressData(sending.contacts.to), cc: addressData(sending.contacts.cc) },
  attach_pdf: sending.rules.attachPdf,
  append_pdfs: sending.rules.appendPdfs,
  attach_files: sending.rules.attachFiles,
  attach_journal: sending.rules.attachJournal,
  journal_formats: sending.rules.journalFormats === null ? null : [...sending.rules.journalFormats],
  organization: {
    attach_pdf: sending.organization.attachPdf,
    append_pdfs: sending.organization.appendPdfs,
    attach_files: sending.organization.attachFiles,
    attach_journal: sending.organization.attachJournal,
    journal_formats: [...sending.organization.journalFormats],
  },
})

const flag = (body: Record<string, unknown>, field: string, errors: FieldError[]): boolean | null => {
  const value = body[field]
  if (value === null || typeof value === 'boolean') return value
  errors.push({ field, code: 'invalid', message: `${field} must be true, false, or null to follow the organization.` })
  return null
}

const parseClientChange = (body: Record<string, unknown>): ClientInvoiceSendingChange => {
  const allowed = new Set([
    'recipients',
    'attach_pdf',
    'append_pdfs',
    'attach_files',
    'attach_journal',
    'journal_formats',
  ])
  const errors: FieldError[] = Object.keys(body)
    .filter((field) => !allowed.has(field))
    .map((field) => ({ field, code: 'unknown_field', message: `${field} is not a field of this resource` }))
  if (Object.keys(body).every((field) => !allowed.has(field))) {
    errors.push({
      field: 'body',
      code: 'required',
      message: 'Provide recipients, an attachment rule, or both.',
    })
  }
  let recipients: ClientInvoiceSendingChange['recipients']
  if (Object.hasOwn(body, 'recipients')) {
    const value = body.recipients
    if (value === null) recipients = null
    else if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      addresses((value as Record<string, unknown>).to) !== null &&
      addresses((value as Record<string, unknown>).cc) !== null &&
      Object.keys(value).every((key) => key === 'to' || key === 'cc')
    ) {
      try {
        recipients = normalizeInvoiceRecipientLists({
          to: addresses((value as Record<string, unknown>).to)!,
          cc: addresses((value as Record<string, unknown>).cc)!,
        })
      } catch (error) {
        asFieldError(error)
      }
    } else {
      errors.push({
        field: 'recipients',
        code: 'invalid',
        message: 'recipients must be { to: [...], cc: [...] }, or null to follow the contacts.',
      })
    }
  }
  const rules: { -readonly [K in keyof ClientAttachmentRules]?: ClientAttachmentRules[K] } = {}
  if (Object.hasOwn(body, 'attach_pdf')) rules.attachPdf = flag(body, 'attach_pdf', errors)
  if (Object.hasOwn(body, 'append_pdfs')) rules.appendPdfs = flag(body, 'append_pdfs', errors)
  if (Object.hasOwn(body, 'attach_files')) rules.attachFiles = flag(body, 'attach_files', errors)
  if (Object.hasOwn(body, 'attach_journal')) {
    const value = body.attach_journal
    if (value === null || value === false || value === 'detailed' || value === 'summary') {
      rules.attachJournal = value
    } else {
      errors.push({
        field: 'attach_journal',
        code: 'invalid',
        message: 'attach_journal must be "detailed", "summary", false, or null to follow the organization.',
      })
    }
  }
  if (Object.hasOwn(body, 'journal_formats')) {
    const value = body.journal_formats
    if (value === null) rules.journalFormats = null
    else {
      const parsed = parseJournalFormats(value)
      if (parsed === null) {
        errors.push({
          field: 'journal_formats',
          code: 'invalid',
          message:
            'journal_formats must be a non-empty list of distinct formats from "pdf", "csv" and "xlsx", or null to follow the organization.',
        })
      } else rules.journalFormats = parsed
    }
  }
  if (errors.length > 0) throw validationError(errors)
  return {
    ...(recipients === undefined ? {} : { recipients }),
    ...(Object.keys(rules).length === 0 ? {} : { rules }),
  }
}

export const installInvoiceSendingRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: InvoiceSendingRouteOptions,
): void => {
  const clock = options.clock ?? (() => new Date().toISOString())

  /**
   * Everything the Send dialog opens on for one invoice, in one read, so it
   * never shows a To from one moment and a Cc from another.
   *
   * Including whether the email can leave. The dialog used to open with
   * delivery unticked whatever the answer, so pressing its button recorded
   * the invoice as sent and emailed nobody. It now opens delivering whenever
   * delivery can happen.
   */
  api.get('/invoices/:id/email-defaults', async (context) => {
    const userId = assertMoneyWriter(context)
    const invoiceId = positiveId(context, 'invoice')
    const defaults = await options.service.emailDefaults(invoiceId, userId)
    if (defaults === null) throw notFound('invoice')
    const delivery = await invoiceEmailReadiness(options.delivery)
    return context.json(
      {
        data: {
          invoice_id: defaults.invoiceId,
          client_id: defaults.clientId,
          company_name: defaults.companyName,
          client_name: defaults.clientName,
          template_version: defaults.templateVersion,
          subject: defaults.subject,
          message: defaults.message,
          to: addressData(defaults.to),
          cc: addressData(defaults.cc),
          recipients_source: defaults.recipientsSource,
          always_cc: addressData(defaults.alwaysCc),
          sender: { name: defaults.sender.name, email: defaults.sender.email },
          send_me_a_copy: defaults.sendMeACopy,
          delivery: {
            available: delivery.available,
            code: delivery.code,
            message: delivery.message,
          },
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/clients/:id/invoice-sending', async (context) => {
    assertMoneyWriter(context)
    const clientId = positiveId(context, 'client')
    const sending = await options.service.readClientSending(clientId)
    if (sending === null) throw notFound('client')
    return context.json({ data: sendingData(sending) }, 200, { 'cache-control': 'no-store' })
  })

  api.post('/clients/:id/invoice-sending', async (context) => {
    assertMoneyWriter(context)
    const clientId = positiveId(context, 'client')
    const change = parseClientChange(await objectBody(context))
    const saved = await options.service.saveClientSending(clientId, change, clock())
    if (saved === null) throw notFound('client')
    return context.json({ data: sendingData(saved) }, 200, { 'cache-control': 'no-store' })
  })

  api.get('/settings/invoice-sending', async (context) => {
    assertMoneyWriter(context)
    return context.json(
      { data: { always_cc: addressData(await options.service.readAlwaysCc()) } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/settings/invoice-sending', async (context) => {
    assertMoneyWriter(context)
    const body = await objectBody(context)
    const unknown = Object.keys(body).filter((field) => field !== 'always_cc')
    const list = addresses(body.always_cc)
    if (unknown.length > 0 || list === null) {
      throw validationError([
        ...unknown.map((field) => ({
          field,
          code: 'unknown_field',
          message: `${field} is not a field of this resource`,
        })),
        ...(list === null
          ? [{ field: 'always_cc', code: 'required', message: 'always_cc must be a list of addresses.' }]
          : []),
      ])
    }
    let normalized: InvoiceAddress[] = []
    try {
      normalized = normalizeInvoiceAddresses(list, 'always_cc', 20)
    } catch (error) {
      asFieldError(error)
    }
    return context.json(
      { data: { always_cc: addressData(await options.service.saveAlwaysCc(normalized)) } },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
