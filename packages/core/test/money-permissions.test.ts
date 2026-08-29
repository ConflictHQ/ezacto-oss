import { describe, expect, it } from 'vitest'
import {
  canViewMoneyField,
  moneyFieldKinds,
  type MoneyFieldKind,
  type UserProfile,
} from '../src/index.js'

const profiles: readonly UserProfile[] = [
  'member',
  'project_manager',
  'people_admin',
  'accounting',
  'executive_manager',
  'administrator',
]

const expectedBaseMatrix: Readonly<
  Record<UserProfile, readonly MoneyFieldKind[]>
> = {
  member: [],
  project_manager: [],
  people_admin: [],
  accounting: ['billable_rate', 'money_budget'],
  executive_manager: ['billable_rate', 'money_budget'],
  administrator: ['billable_rate', 'cost_rate', 'money_budget'],
} as const

describe('money-field permissions', () => {
  it('[unit] encodes every money field across all six base profiles', () => {
    for (const profile of profiles) {
      const visible = moneyFieldKinds.filter((field) =>
        canViewMoneyField({ profile, managerGrants: [] }, field),
      )
      expect(visible, profile).toEqual(expectedBaseMatrix[profile])
    }
  })

  it('[security] limits the manager grant to billable rates', () => {
    const manager = {
      profile: 'project_manager' as const,
      managerGrants: ['billable_rates_manager'],
    }
    expect(canViewMoneyField(manager, 'billable_rate')).toBe(true)
    expect(canViewMoneyField(manager, 'cost_rate')).toBe(false)
    expect(canViewMoneyField(manager, 'money_budget')).toBe(false)
  })

  it('[security] ignores manager grants on every other profile', () => {
    for (const profile of profiles.filter(
      (candidate) => candidate !== 'project_manager',
    )) {
      const viewer = { profile, managerGrants: ['billable_rates_manager'] }
      expect(canViewMoneyField(viewer, 'billable_rate'), profile).toBe(
        expectedBaseMatrix[profile].includes('billable_rate'),
      )
    }
  })

  it('[security] fails closed for an unrecognized runtime field category', () => {
    expect(
      canViewMoneyField(
        {
          profile: 'administrator',
          managerGrants: ['billable_rates_manager'],
        },
        'future_money_field' as MoneyFieldKind,
      ),
    ).toBe(false)
  })
})
