import type { GeneralResourceKind } from './general-resources.js'
import { canViewMoneyField, type ActingUserAuthority } from './money-permissions.js'

/** Non-cents fields that disclose or change commercial pricing arrangements. */
export const commercialTermFields: Partial<Readonly<Record<GeneralResourceKind, readonly string[]>>> = {
  clients: ['paymentTerms', 'defaultTaxPct', 'defaultTax2Pct', 'defaultDiscountPct'],
  projects: ['billingMethod', 'billBy', 'billingCurrency'],
  contacts: ['invoiceRecipientStatus'],
}

export const isCommercialTermField = (kind: GeneralResourceKind, field: string): boolean =>
  commercialTermFields[kind]?.includes(field) ?? false

/** Reading and changing terms require the same explicit commercial authority. */
export const canManageCommercialTerms = (viewer: Readonly<ActingUserAuthority>): boolean =>
  canViewMoneyField(viewer, 'billable_rate')
