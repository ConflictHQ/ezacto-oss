import type { InvoiceProviderAlert } from '@conflict-hq/ezacto-client'
export type { InvoiceProviderAlert } from '@conflict-hq/ezacto-client'

export interface InvoiceProviderAlertApi {
  listInvoiceProviderAlerts?(id: number, signal?: AbortSignal): Promise<readonly InvoiceProviderAlert[]>
  reviewInvoiceProviderAlert?(id: number, alertId: string, signal?: AbortSignal): Promise<InvoiceProviderAlert>
}

export const renderInvoiceProviderAlerts = (): string => `
  <section class="invoice-history" data-invoice-provider-alerts hidden aria-labelledby="invoice-provider-alerts-heading">
    <h3 id="invoice-provider-alerts-heading">Stripe payment alerts</h3>
    <p>Refunds and disputes require review. Recorded payments and the invoice balance are unchanged. Marking an alert reviewed only records your review.</p>
    <p>Each refund report shows the total refunded for its charge. Do not add refund reports together.</p>
    <p data-invoice-provider-alert-status class="form-result" role="status" aria-live="polite"></p>
    <button type="button" data-invoice-provider-alert-retry hidden>Retry alerts</button>
    <ul data-invoice-provider-alert-list></ul>
  </section>`

