import type { Whoami } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  parseTeamCapacitySeconds,
  parseTeamMoneyCents,
  ratePeriod,
  teamCapabilities,
  teamPersonIdFromPathname,
  teamUtilization,
  teamWeekRange,
} from '../src/team/model.js'

const identity = (
  profile: Whoami['profile'],
  authentication: Whoami['authentication'] = { kind: 'session' },
  manager_grants: readonly string[] = [],
): Whoami => ({ user_id: 1, profile, manager_grants: [...manager_grants], authentication })

describe('Team view model', () => {
  it('maps session profiles to people, profile, and exact rate capabilities', () => {
    expect(teamCapabilities(identity('member')).canRead).toBe(false)
    expect(teamCapabilities(identity('accounting')).canRead).toBe(false)
    expect(teamCapabilities(identity('people_admin'))).toMatchObject({
      canRead: true,
      canManagePeople: true,
      canChangeProfile: false,
      canAppendBillableRate: false,
      canAppendCostRate: false,
    })
    expect(teamCapabilities(identity('administrator'))).toMatchObject({
      canManagePeople: true,
      canChangeProfile: true,
      canAppendBillableRate: true,
      canAppendCostRate: true,
    })
    expect(
      teamCapabilities(
        identity('project_manager', { kind: 'session' }, ['billable_rates_manager']),
      ),
    ).toMatchObject({
      canManagePeople: false,
      canAppendBillableRate: true,
      canAppendCostRate: false,
    })
  })

  it('fails closed for tokens without team:read and never grants token mutations', () => {
    expect(
      teamCapabilities(
        identity('administrator', {
          kind: 'token',
          token_id: 2,
          scopes: ['projects:read'],
        }),
      ),
    ).toEqual({
      canRead: false,
      canManagePeople: false,
      canChangeProfile: false,
      canAppendBillableRate: false,
      canAppendCostRate: false,
    })
  })

  it('uses exact integer conversions and rejects lossy values', () => {
    expect(parseTeamMoneyCents('125.01')).toBe(12_501)
    expect(parseTeamCapacitySeconds('37.5')).toBe(135_000)
    expect(() => parseTeamMoneyCents('1.001')).toThrow('two decimals')
    expect(() => parseTeamCapacitySeconds('0.000001')).toThrow('whole number of seconds')
  })

  it('builds canonical Monday weeks and person routes', () => {
    expect(teamWeekRange('2026-09-02')).toEqual({
      from: '2026-08-31',
      to: '2026-09-06',
    })
    expect(teamWeekRange('2026-09-02', 'saturday')).toEqual({
      from: '2026-08-29',
      to: '2026-09-04',
    })
    expect(teamPersonIdFromPathname('/team/42')).toBe(42)
    expect(teamPersonIdFromPathname('/team/nope')).toBeNull()
  })

  it('labels server utilization and closed effective periods without recomputing them', () => {
    expect(teamUtilization(1_125_000)).toBe('112.5%')
    expect(teamUtilization(null)).toBe('No capacity')
    expect(ratePeriod({ start_date: '2026-01-01', end_date: '2026-08-31' })).toBe(
      '2026-01-01 – 2026-08-31',
    )
  })
})
