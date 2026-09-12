import type { GeneralResource, Whoami } from '@conflict-hq/ezacto-client'

export interface RoleAdminPage {
  readonly data: readonly GeneralResource[]
  readonly page: { readonly next_cursor: string | null }
}

export interface RoleAdminApi {
  listRoles(cursor?: string, signal?: AbortSignal): Promise<RoleAdminPage>
  /** Who holds which role, so a delete can say what it is about to detach. */
  listRoleHolders?(signal?: AbortSignal): Promise<RoleAdminPage>
  createRole(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateRole(
    id: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  deleteRole(id: number, signal?: AbortSignal): Promise<void>
}

/**
 * The same authority that manages people, because a role is a fact about them.
 *
 * Taken from the API's own `sessionWriteProfiles` entry for `roles` rather than
 * restated as a shorter list here: a local copy is one edit away from a button
 * that opens a form the route then refuses.
 */
export const canManageRoles = (profile: Whoami['profile']): boolean =>
  profile === 'people_admin' ||
  profile === 'executive_manager' ||
  profile === 'administrator'

export const roleName = (resource: Readonly<GeneralResource>): string => {
  const value = resource['name']
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : `Role #${String(resource.id)}`
}

/**
 * A name already taken, ignoring case and surrounding space.
 *
 * `roles.name` is UNIQUE, so the server refuses a duplicate with a constraint
 * error. Catching it here turns that into a sentence about the name rather than
 * a failed save, and `excludeId` is what lets a rename keep its own name.
 */
export const roleNameTaken = (
  roles: readonly GeneralResource[],
  name: string,
  excludeId: number | null,
): boolean => {
  const wanted = name.trim().toLocaleLowerCase('en-US')
  if (wanted === '') return false
  return roles.some(
    (role) =>
      role.id !== excludeId &&
      roleName(role).toLocaleLowerCase('en-US') === wanted,
  )
}

/** How many people hold each role, keyed by role id. */
export const roleHolderCounts = (
  people: readonly GeneralResource[],
): ReadonlyMap<number, number> => {
  const counts = new Map<number, number>()
  for (const person of people) {
    const roles = person['role_ids']
    if (!Array.isArray(roles)) continue
    for (const id of roles) {
      if (typeof id !== 'number') continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return counts
}

export const roleHolderLabel = (holders: number): string =>
  holders === 0
    ? 'Nobody holds this role.'
    : `${holders} ${holders === 1 ? 'person holds' : 'people hold'} this role.`
