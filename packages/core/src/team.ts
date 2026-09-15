import type { UserProfile } from './api-authorization.js'

export const teamProfiles = [
  'member',
  'project_manager',
  'people_admin',
  'accounting',
  'executive_manager',
  'administrator',
] as const satisfies readonly UserProfile[]

export const reminderDays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

export type ReminderDay = (typeof reminderDays)[number]
export type TeamRateKind = 'billable' | 'cost'

export interface TeamViewer {
  userId: number
  profile: UserProfile
  managerGrants: readonly string[]
}

export interface TeamListFilter {
  from: string
  to: string
  isActive?: boolean
}

export interface TeamListWindow {
  afterId: number | null
  throughId: number
  take: number
}

export interface TeamPersonSummary {
  id: number
  firstName: string
  lastName: string
  email: string | null
  avatarUrl: string | null
  profile: UserProfile
  isOwner: boolean
  isContractor: boolean
  isActive: boolean
  weeklyCapacity: number
  totalSeconds: number
  billableSeconds: number
  nonbillableSeconds: number
  utilizationPpm: number | null
  running: boolean
}

export interface TeamNamedRelation {
  id: number
  name: string
}

export interface TeamProjectAssignment {
  id: number
  projectId: number
  projectName: string
  projectCode: string
  clientId: number
  clientName: string
  isActive: boolean
  isProjectManager: boolean
  useDefaultRates: boolean
  hourlyRateCents: number | null
  budgetSeconds: number | null
  updatedAt: string
}

export interface TeamRateRecord {
  id: number
  userId: number
  amountCents: number
  startDate: string | null
  endDate: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamNotificationPreference {
  deliveryActive: false
  dailyReminderEnabled: boolean
  reminderTime: string | null
  reminderDays: readonly ReminderDay[]
  emailEnabled: boolean
  desktopEnabled: boolean
  slackEnabled: boolean
  includeInTeamReminders: boolean
  weeklyDigest: boolean
  notifyProjectDeleted: boolean
  updatedAt: string
}

export interface TeamPersonRecord {
  id: number
  firstName: string
  lastName: string
  email: string | null
  telephone: string | null
  employeeId: string | null
  timezone: string
  isContractor: boolean
  isActive: boolean
  hasAccessToAllFutureProjects: boolean
  weeklyCapacity: number
  profile: UserProfile
  isOwner: boolean
  avatarUrl: string | null
  version: number
  createdAt: string
  updatedAt: string
  roles: readonly TeamNamedRelation[]
  departments: readonly TeamNamedRelation[]
  projectAssignments: readonly TeamProjectAssignment[]
  billableRates: readonly TeamRateRecord[]
  costRates: readonly TeamRateRecord[]
  notifications: TeamNotificationPreference
}

export interface TeamPersonPatch {
  firstName?: string
  lastName?: string
  telephone?: string | null
  employeeId?: string | null
  timezone?: string
  isContractor?: boolean
  isActive?: boolean
  hasAccessToAllFutureProjects?: boolean
  weeklyCapacity?: number
  profile?: UserProfile
  roleIds?: readonly number[]
  departmentIds?: readonly number[]
}

export interface TeamAssignmentInput {
  projectId: number
  isProjectManager: boolean
}

export interface TeamNotificationPatch {
  dailyReminderEnabled: boolean
  reminderTime: string | null
  reminderDays: readonly ReminderDay[]
  emailEnabled: boolean
  desktopEnabled: boolean
  slackEnabled: boolean
  includeInTeamReminders: boolean
  weeklyDigest: boolean
  notifyProjectDeleted: boolean
}

export type TeamCommandKind =
  | 'person.update'
  | 'person.assignments.replace'
  | 'person.notifications.update'
  | 'person.billable_rate.append'
  | 'person.cost_rate.append'
  | 'person.billable_rate.remove'
  | 'person.cost_rate.remove'

export interface TeamCommand {
  commandId: string
  commandKind: TeamCommandKind
  targetUserId: number
  actorUserId: number
  expectedVersion: number
  occurredAt: string
}

export interface TeamCommandReceipt {
  targetUserId: number
  version: number
  resourceId: number | null
  occurredAt: string
}

export type TeamErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'state_conflict'
  | 'command_id_reused'
  | 'invalid_input'

export class TeamError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TeamError'
  }
}

export interface TeamRepository {
  highWatermark(
    viewer: Readonly<TeamViewer>,
    filter: Readonly<TeamListFilter>,
  ): Promise<number | null>
  list(
    viewer: Readonly<TeamViewer>,
    filter: Readonly<TeamListFilter>,
    window: Readonly<TeamListWindow>,
  ): Promise<readonly TeamPersonSummary[]>
  get(viewer: Readonly<TeamViewer>, userId: number): Promise<TeamPersonRecord | null>
  updatePerson(
    command: Readonly<TeamCommand>,
    patch: Readonly<TeamPersonPatch>,
  ): Promise<TeamCommandReceipt>
  replaceAssignments(
    command: Readonly<TeamCommand>,
    assignments: readonly Readonly<TeamAssignmentInput>[],
  ): Promise<TeamCommandReceipt>
  updateNotifications(
    command: Readonly<TeamCommand>,
    patch: Readonly<TeamNotificationPatch>,
  ): Promise<TeamCommandReceipt>
  appendRate(
    command: Readonly<TeamCommand>,
    input: Readonly<{ kind: TeamRateKind; amountCents: number; startDate: string | null }>,
  ): Promise<TeamCommandReceipt>
  /**
   * Take back a rate that was never meant to be added (#727).
   *
   * Only the current one, and only while nothing has been priced from it: the
   * schema decides both, because a rule that lives in a caller is a rule the
   * next caller does not have. Removing it reopens whatever it displaced --
   * adding a rate ends the one before it, so taking the addition away has to
   * put that one back or the mistake is only half undone.
   */
  removeRate(
    command: Readonly<TeamCommand>,
    input: Readonly<{ kind: TeamRateKind; rateId: number }>,
  ): Promise<TeamCommandReceipt>
  listRoles(): Promise<readonly TeamNamedRelation[]>
  listDepartments(): Promise<readonly TeamNamedRelation[]>
  listAssignableProjects(): Promise<
    readonly {
      id: number
      name: string
      code: string
      clientId: number
      clientName: string
      isActive: boolean
    }[]
  >
}
