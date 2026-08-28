export type UserProfile =
  | 'member'
  | 'project_manager'
  | 'people_admin'
  | 'accounting'
  | 'executive_manager'
  | 'administrator'

export const apiScopes = [
  'time_entries:read',
  'time_entries:write',
  'projects:read',
  'projects:write',
  'clients:read',
  'clients:write',
  'invoices:read',
  'invoices:write',
  'expenses:read',
  'expenses:write',
  'team:read',
  'schedule:read',
  'schedule:write',
  'reports:read',
] as const

export type ApiScope = (typeof apiScopes)[number]

const everyProfile: readonly UserProfile[] = [
  'member',
  'project_manager',
  'people_admin',
  'accounting',
  'executive_manager',
  'administrator',
]
const projectManagement: readonly UserProfile[] = [
  'project_manager',
  'executive_manager',
  'administrator',
]
const clientManagement: readonly UserProfile[] = [
  'project_manager',
  'accounting',
  'executive_manager',
  'administrator',
]
const peopleVisibility: readonly UserProfile[] = [
  'project_manager',
  'people_admin',
  'executive_manager',
  'administrator',
]
const moneyRead: readonly UserProfile[] = [
  'accounting',
  'executive_manager',
  'administrator',
]
const reports: readonly UserProfile[] = ['accounting', 'executive_manager', 'administrator']

/**
 * The shared scope/profile ceiling. Resource handlers still enforce assignment,
 * row ownership, and serializer redaction; this policy can only deny earlier.
 */
export const apiScopeProfiles: Readonly<Record<ApiScope, readonly UserProfile[]>> = {
  'time_entries:read': everyProfile,
  'time_entries:write': everyProfile,
  'projects:read': everyProfile,
  'projects:write': projectManagement,
  'clients:read': everyProfile,
  'clients:write': clientManagement,
  'invoices:read': moneyRead,
  'invoices:write': moneyRead,
  'expenses:read': everyProfile,
  'expenses:write': everyProfile,
  'team:read': peopleVisibility,
  'schedule:read': everyProfile,
  'schedule:write': projectManagement,
  'reports:read': reports,
}

const apiScopeSet: ReadonlySet<string> = new Set(apiScopes)

export const isApiScope = (value: string): value is ApiScope => apiScopeSet.has(value)

export const canProfileUseApiScope = (profile: UserProfile, scope: ApiScope): boolean =>
  apiScopeProfiles[scope].includes(profile)

export const profilesAllowedEveryApiScope = (
  scopes: readonly ApiScope[],
): readonly UserProfile[] =>
  everyProfile.filter((profile) => scopes.every((scope) => canProfileUseApiScope(profile, scope)))
