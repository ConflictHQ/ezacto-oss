/** Native financial integrations. Availability is configuration, never a claim of a live connection. */
export const accountingProviders = [
  { id: 'quickbooks', label: 'QuickBooks Online', purpose: 'Accounting', configured: 'Available to connect' },
  { id: 'bill', label: 'BILL', purpose: 'Invoice delivery and receivables', configured: 'Deployment configured' },
  { id: 'wise', label: 'Wise', purpose: 'Payouts', configured: 'Deployment configured' },
  { id: 'deel', label: 'Deel', purpose: 'Approved time sync', configured: 'Deployment configured' },
] as const
export type AccountingProviderId = (typeof accountingProviders)[number]['id']
export type AccountingProviderAvailability = Readonly<Record<AccountingProviderId, boolean>>

/** Per-provider gates remain separate when another provider makes the section available. */
export const accountingProviderAvailable = (provider: AccountingProviderId): boolean =>
  !document.documentElement.hasAttribute('data-accounting-unavailable') &&
  !document.documentElement.hasAttribute(`data-${provider}-unavailable`)

export const renderAccountingProviders = (availability?: AccountingProviderAvailability): string =>
  availability === undefined ? '' : `<dl class="settings-facts" data-accounting-providers>${accountingProviders.map(provider =>
    `<div data-accounting-provider="${provider.id}" data-provider-available="${String(availability[provider.id])}"><dt>${provider.label}</dt><dd>${provider.purpose} · ${availability[provider.id] ? provider.configured : 'Not configured'}</dd></div>`
  ).join('')}</dl>`
