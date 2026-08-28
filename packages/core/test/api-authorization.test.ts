import { describe, expect, it } from 'vitest'
import {
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
    expect(profilesAllowedEveryApiScope(['reports:read'])).toContain('member')
    expect(profilesAllowedEveryApiScope(['reports:read', 'invoices:write'])).toEqual([
      'accounting',
      'administrator',
    ])
  })
})
