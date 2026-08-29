import type { UserProfile } from './api-authorization.js'

export const moneyFieldKinds = [
  'billable_rate',
  'cost_rate',
  'money_budget',
] as const

export type MoneyFieldKind = (typeof moneyFieldKinds)[number]

/**
 * The application-owned authority shared by browser sessions, API tokens, and
 * future agent/MCP callers. Machine callers do not get an independent profile.
 */
export interface ActingUserAuthority {
  profile: UserProfile
  managerGrants: readonly string[]
}

const billableMoneyProfiles: ReadonlySet<UserProfile> = new Set([
  'accounting',
  'executive_manager',
  'administrator',
])

const moneyBudgetProfiles: ReadonlySet<UserProfile> = new Set([
  'accounting',
  'executive_manager',
  'administrator',
])

export const canViewMoneyField = (
  viewer: Readonly<ActingUserAuthority>,
  field: MoneyFieldKind,
): boolean => {
  switch (field) {
    case 'cost_rate':
      return viewer.profile === 'administrator'
    case 'money_budget':
      return moneyBudgetProfiles.has(viewer.profile)
    case 'billable_rate':
      return (
        billableMoneyProfiles.has(viewer.profile) ||
        (viewer.profile === 'project_manager' &&
          viewer.managerGrants.includes('billable_rates_manager'))
      )
    default:
      return false
  }
}
