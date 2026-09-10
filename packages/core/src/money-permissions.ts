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
  /**
   * Who is asking. Optional because the authority is also built by callers that
   * never name a subject -- the web shell deciding whether to draw the
   * commercial-terms fields at all, for one -- and a required field would make
   * every such caller invent a user id to satisfy a rule that will not read it.
   * The self branch below demands a number, so an authority that omits this can
   * only ever be told what a profile alone entitles it to.
   */
  userId?: number
  /**
   * The organisation setting from #520: does this instance let a person see
   * their own billable rate and their own take-home? Off unless an
   * administrator turned it on, and `undefined` -- an authority assembled
   * before this existed, or by a caller with no access to the setting -- is off
   * too. An upgrade must not start disclosing rates because it was deployed.
   */
  ownMoneyVisible?: boolean
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

/**
 * Is this figure the viewer's own money, on an instance that permits reading
 * it? Every clause is required and none of them defaults to a match: a viewer
 * with no `userId` and a figure with no subject are both unknowns, and the one
 * thing they must never do is compare equal to each other and hand a member
 * somebody else's payroll.
 */
const readsOwnMoney = (
  viewer: Readonly<ActingUserAuthority>,
  subjectUserId: number | null,
): boolean =>
  viewer.ownMoneyVisible === true &&
  typeof viewer.userId === 'number' &&
  subjectUserId !== null &&
  viewer.userId === subjectUserId

/**
 * `subjectUserId` is the person whose money this is, or null for a figure that
 * belongs to no one person -- a project budget, a client rollup, a firm-wide
 * total. It defaults to null so that a caller who has not thought about whose
 * money it is gets the profile-only answer this rule gave before #520: the
 * subject can only ever widen what a viewer sees, and only onto themselves.
 */
export const canViewMoneyField = (
  viewer: Readonly<ActingUserAuthority>,
  field: MoneyFieldKind,
  subjectUserId: number | null = null,
): boolean => {
  switch (field) {
    case 'cost_rate':
      return (
        viewer.profile === 'administrator' || readsOwnMoney(viewer, subjectUserId)
      )
    case 'money_budget':
      // No self branch, and not an oversight: a budget is money the firm holds
      // against a project or a client, so there is no person it could belong
      // to. Handing one to whoever happens to be the subject of the request
      // would be a different feature than #520 asked for.
      return moneyBudgetProfiles.has(viewer.profile)
    case 'billable_rate':
      return (
        billableMoneyProfiles.has(viewer.profile) ||
        (viewer.profile === 'project_manager' &&
          viewer.managerGrants.includes('billable_rates_manager')) ||
        readsOwnMoney(viewer, subjectUserId)
      )
    default:
      return false
  }
}
