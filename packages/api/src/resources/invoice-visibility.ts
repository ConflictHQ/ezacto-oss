import type { TrackedState } from '@ezacto/core'
import { canPrincipalUseApiScope } from '../auth.js'
import type { UserPrincipal } from '../context.js'
import { ApiError } from '../errors.js'

export const invoiceStateForViewer = (state: Readonly<TrackedState>, viewer: Readonly<UserPrincipal>) => {
  const mayReadInvoices = canPrincipalUseApiScope(viewer, 'invoices:read')
  const hideReason = !mayReadInvoices && state.lockedReasonCode === 'invoiced'
  return {
    ...(mayReadInvoices ? { invoice_id: state.invoiceId, is_billed: state.isBilled } : {}),
    is_locked: state.isLocked,
    locked_reason_code: hideReason ? 'locked' : state.lockedReasonCode,
    locked_reason: hideReason ? 'This record is locked.' : state.lockedReason,
  }
}

export const authorizeInvoiceFilters = (params: ReadonlyMap<string, string>, viewer: Readonly<UserPrincipal>): void => {
  if ((params.has('invoice_id') || params.has('is_billed')) && !canPrincipalUseApiScope(viewer, 'invoices:read')) {
    throw new ApiError({
      status: 403,
      code: 'invoice_filter_forbidden',
      message: 'Invoice filters require invoice-read authority.',
    })
  }
}
