import { describe, expect, it } from 'vitest'
import { canManageCommercialTerms, commercialTermFields, isCommercialTermField } from '../src/index.js'

describe('commercial field policy', () => {
  it('[security #466] classifies the non-cents commercial surface explicitly', () => {
    expect(commercialTermFields).toEqual({
      clients: ['paymentTerms', 'defaultTaxPct', 'defaultTax2Pct', 'defaultDiscountPct'],
      projects: ['billingMethod', 'billBy', 'billingCurrency'],
      contacts: ['invoiceRecipientStatus'],
    })
    expect(isCommercialTermField('clients', 'paymentTerms')).toBe(true)
    expect(isCommercialTermField('clients', 'name')).toBe(false)
  })

  it('[security #466] requires finance authority or an explicit commercial manager grant', () => {
    for (const profile of ['member', 'people_admin', 'project_manager', 'accounting', 'executive_manager', 'administrator'] as const) {
      for (const managerGrants of [[], ['billable_rates_manager']]) {
        expect(canManageCommercialTerms({ profile, managerGrants }), `${profile}:${managerGrants}`).toBe(
          ['accounting', 'executive_manager', 'administrator'].includes(profile) ||
          (profile === 'project_manager' && managerGrants.length > 0),
        )
      }
    }
  })
})
