import type { GeneralResource } from '@conflict-hq/ezacto-client'
import { describe, expect, it } from 'vitest'
import {
  canManageRoles,
  roleHolderCounts,
  roleHolderLabel,
  roleName,
  roleNameTaken,
} from '../src/roles/model.js'

const role = (id: number, name: unknown): GeneralResource =>
  ({ id, name }) as unknown as GeneralResource

const person = (id: number, roleIds: unknown): GeneralResource =>
  ({ id, role_ids: roleIds }) as unknown as GeneralResource

describe('role admin model', () => {
  it('[security] lets only the profiles the route accepts manage roles', () => {
    // The same three the API grants roles writes to. Written as a literal list
    // rather than derived, so widening the route without widening this fails.
    expect(canManageRoles('people_admin')).toBe(true)
    expect(canManageRoles('executive_manager')).toBe(true)
    expect(canManageRoles('administrator')).toBe(true)
    expect(canManageRoles('member')).toBe(false)
    expect(canManageRoles('project_manager')).toBe(false)
    expect(canManageRoles('accounting')).toBe(false)
  })

  it('[unit] names a role that has lost its name rather than rendering blank', () => {
    expect(roleName(role(4, 'Designer'))).toBe('Designer')
    expect(roleName(role(4, '  Designer  '))).toBe('Designer')
    // A blank or absent name would otherwise render an empty card with a
    // Delete button and no way to tell which role it is.
    expect(roleName(role(4, '   '))).toBe('Role #4')
    expect(roleName(role(4, null))).toBe('Role #4')
  })

  it('[unit] catches a duplicate name before the unique constraint does', () => {
    const roles = [role(1, 'Designer'), role(2, 'Engineer')]
    expect(roleNameTaken(roles, 'Designer', null)).toBe(true)
    // roles.name is UNIQUE and SQLite does not care about case, but a person
    // reading the list does: two roles differing only in case are the same
    // role twice.
    expect(roleNameTaken(roles, 'designer', null)).toBe(true)
    expect(roleNameTaken(roles, '  DESIGNER ', null)).toBe(true)
    expect(roleNameTaken(roles, 'Producer', null)).toBe(false)
    // A rename keeps its own name, or saving a role without changing it fails.
    expect(roleNameTaken(roles, 'Designer', 1)).toBe(false)
    expect(roleNameTaken(roles, 'Designer', 2)).toBe(true)
    // Nothing is taken by nothing; the empty case is the form's own error.
    expect(roleNameTaken(roles, '   ', null)).toBe(false)
  })

  it('[unit] counts holders so a delete can say what it detaches', () => {
    const counts = roleHolderCounts([
      person(1, [1, 2]),
      person(2, [2]),
      person(3, []),
      // Shapes that arrive from the wire and must not throw or be counted.
      person(4, null),
      person(5, ['2']),
    ])
    expect(counts.get(1)).toBe(1)
    expect(counts.get(2)).toBe(2)
    expect(counts.get(9)).toBeUndefined()
  })

  it('[unit] says how many hold a role in words that agree with the number', () => {
    expect(roleHolderLabel(0)).toBe('Nobody holds this role.')
    expect(roleHolderLabel(1)).toBe('1 person holds this role.')
    expect(roleHolderLabel(4)).toBe('4 people hold this role.')
  })
})
