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

/**
 * #520 gave the rule a subject. Two things have to be true before a person sees
 * their own money -- the organisation turned the setting on, and the figure is
 * theirs -- so every case below holds one of them true and breaks the other.
 * The self branch can only ever widen, and only onto the viewer.
 */
describe('own-money visibility (#520)', () => {
  const self = 7
  const someoneElse = 8

  const viewer = (
    profile: UserProfile,
    overrides: Partial<{ userId: number; ownMoneyVisible: boolean }> = {},
  ) => ({ profile, managerGrants: [], userId: self, ownMoneyVisible: true, ...overrides })

  it('[security] withholds another person’s rates from every profile the setting widens', () => {
    // The half that fails quietly if the subject check is wrong: a rule that
    // read the setting and forgot the subject would pass every other case here
    // and this would be the only thing that noticed. Asserted against the base
    // matrix rather than against `false`, because an administrator still sees
    // cost on anybody's row and `false` would be wrong for the right reason.
    expect(profiles).toHaveLength(6)
    for (const profile of profiles) {
      for (const field of moneyFieldKinds) {
        expect(
          canViewMoneyField(viewer(profile), field, someoneElse),
          `${profile}:${field}`,
        ).toBe(expectedBaseMatrix[profile].includes(field))
      }
    }
  })

  it('[security] shows a person their own rate and take-home on every profile', () => {
    expect(profiles).toHaveLength(6)
    for (const profile of profiles) {
      expect(canViewMoneyField(viewer(profile), 'cost_rate', self), profile).toBe(true)
      expect(canViewMoneyField(viewer(profile), 'billable_rate', self), profile).toBe(true)
    }
  })

  it('[security] leaves a figure that belongs to nobody at the profile answer', () => {
    // A project budget, a client rollup, a firm-wide total: no subject, so the
    // setting cannot reach it however many people it is about. The defaulted
    // call is the same assertion for every caller that has not been given a
    // subject to pass.
    for (const profile of profiles) {
      for (const field of moneyFieldKinds) {
        expect(canViewMoneyField(viewer(profile), field, null), `${profile}:${field}`).toBe(
          expectedBaseMatrix[profile].includes(field),
        )
        expect(canViewMoneyField(viewer(profile), field), `${profile}:${field}:defaulted`).toBe(
          expectedBaseMatrix[profile].includes(field),
        )
      }
    }
  })

  it('[security] stays shut while the organisation setting is off', () => {
    for (const profile of profiles) {
      for (const field of moneyFieldKinds) {
        expect(
          canViewMoneyField(viewer(profile, { ownMoneyVisible: false }), field, self),
          `${profile}:${field}`,
        ).toBe(expectedBaseMatrix[profile].includes(field))
      }
    }
  })

  it('[security] refuses to match an authority that never said who it is', () => {
    // Two unknowns must not compare equal. An authority with no `userId` and a
    // figure with no subject are both absent, and the day absent matches absent
    // is the day a member reads the payroll.
    const anonymous = { profile: 'member' as const, managerGrants: [], ownMoneyVisible: true }
    expect(canViewMoneyField(anonymous, 'cost_rate', self)).toBe(false)
    expect(canViewMoneyField(anonymous, 'cost_rate', null)).toBe(false)
    expect(canViewMoneyField(anonymous, 'billable_rate', self)).toBe(false)
  })

  it('[security] keeps money_budget out of self access entirely', () => {
    expect(canViewMoneyField(viewer('member'), 'money_budget', self)).toBe(false)
    expect(canViewMoneyField(viewer('project_manager'), 'money_budget', self)).toBe(false)
  })
})
