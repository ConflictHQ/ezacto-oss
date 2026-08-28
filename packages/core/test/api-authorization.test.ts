import { describe, expect, it } from 'vitest'
import {
  apiScopeProfiles,
  apiScopes,
  canProfileUseApiScope,
  isApiScope,
  profilesAllowedEveryApiScope,
} from '../src/index.js'

describe('API scope/profile policy', () => {
  it('[unit] recognizes only the canonical retained scope vocabulary', () => {
    expect(apiScopes).toContain('time_entries:read')
    expect(isApiScope('time_entries:read')).toBe(true)
    expect(isApiScope('time:read')).toBe(false)
    expect(isApiScope('admin:everything')).toBe(false)
  })

  it('[security] requires the user profile independently of a granted scope', () => {
    expect(canProfileUseApiScope('member', 'invoices:write')).toBe(false)
    expect(canProfileUseApiScope('accounting', 'invoices:write')).toBe(true)
    expect(canProfileUseApiScope('administrator', 'invoices:write')).toBe(true)
  })

  it('[unit] derives the atomic issuance/authentication ceiling for a scope set', () => {
    expect(profilesAllowedEveryApiScope(['reports:read'])).toEqual([
      'accounting',
      'executive_manager',
      'administrator',
    ])
    expect(profilesAllowedEveryApiScope(['reports:read', 'invoices:write'])).toEqual([
      'accounting',
      'executive_manager',
      'administrator',
    ])
  })

  it('[security] exactly encodes the authoritative six-profile capability grid', () => {
    expect(apiScopeProfiles).toEqual({
      'time_entries:read': [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'time_entries:write': [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'projects:read': [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'projects:write': ['project_manager', 'executive_manager', 'administrator'],
      'clients:read': [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'clients:write': [
        'project_manager',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'invoices:read': ['accounting', 'executive_manager', 'administrator'],
      'invoices:write': ['accounting', 'executive_manager', 'administrator'],
      'expenses:read': [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'expenses:write': [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'team:read': ['project_manager', 'people_admin', 'executive_manager', 'administrator'],
      'schedule:read': [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
      'schedule:write': ['project_manager', 'executive_manager', 'administrator'],
      'reports:read': ['accounting', 'executive_manager', 'administrator'],
    })
  })
})
