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
 * The profiles that review other people's submitted work. It is one question --
 * who supervises whom -- so timesheets and expenses answer it from here rather
 * than each stating their own list and drifting apart.
 *
 * Deliberately not `people_admin` or `accounting`: administering people and
 * seeing money are different authorities from approving someone's week.
 */
const submissionReview: readonly UserProfile[] = [
  'project_manager',
  'executive_manager',
  'administrator',
]

export const canReviewSubmissions = (profile: UserProfile): boolean =>
  submissionReview.includes(profile)

/**
 * How many submissions one bulk approval may carry. A request parser and the
 * approval ledger's own CHECK both need this number, and they sit in different
 * packages, so it is stated once here rather than twice and left to drift.
 *
 * Fifty, not a page of the queue, because approving a week of someone's work is
 * irreversible without an administrator: a full page should cost more than one
 * confirmation.
 */
export const maximumBulkApprovalSelections = 50

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
