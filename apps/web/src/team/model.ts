import type {
  GeneralResource,
  TeamAssignmentReplaceInput,
  TeamCatalog,
  TeamCommandReceipt,
  TeamNotificationInput,
  TeamPerson,
  TeamPersonPatch,
  TeamPersonSummaryPage,
  TeamRateInput,
  UserRate,
  Whoami,
} from '@ezacto/client'

/**
 * What a person needs to exist. Everything else the record carries has a column
 * default, and the person editor is where the rest of it is filled in; this is
 * the first stage of #361, which stops short of the invitation itself.
 */
export type TeamPersonCreate = {
  readonly first_name: string
  readonly last_name: string
  readonly email: string
  readonly weekly_capacity: number
  readonly is_contractor: boolean
  readonly profile?: TeamProfile
}

export interface TeamDirectoryApi {
  getTeamStatus(signal?: AbortSignal): Promise<{ readonly enabled: boolean }>
  getTeamWeekStartDay?(
    signal?: AbortSignal,
  ): Promise<'saturday' | 'sunday' | 'monday'>
  listTeamPeople(
    filter: {
      readonly from: string
      readonly to: string
      readonly is_active?: boolean
    },
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<TeamPersonSummaryPage>
  getTeamPerson(id: number, signal?: AbortSignal): Promise<TeamPerson>
  getTeamCatalog(signal?: AbortSignal): Promise<TeamCatalog>
  createTeamPerson(
    input: TeamPersonCreate,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateTeamPerson(
    id: number,
    commandId: string,
    input: TeamPersonPatch,
    signal?: AbortSignal,
  ): Promise<TeamCommandReceipt>
  replaceTeamPersonProjectAssignments(
    id: number,
    commandId: string,
    input: TeamAssignmentReplaceInput,
    signal?: AbortSignal,
  ): Promise<TeamCommandReceipt>
  updateTeamPersonNotifications(
    id: number,
    commandId: string,
    input: TeamNotificationInput,
    signal?: AbortSignal,
  ): Promise<TeamCommandReceipt>
  appendTeamPersonRate(
    id: number,
    commandId: string,
    input: TeamRateInput,
    signal?: AbortSignal,
  ): Promise<TeamCommandReceipt>
}

export interface TeamCapabilities {
  readonly canRead: boolean
  readonly canManagePeople: boolean
  readonly canChangeProfile: boolean
  readonly canAppendBillableRate: boolean
  readonly canAppendCostRate: boolean
}

export const teamCapabilities = (
  identity: Pick<Whoami, 'profile' | 'manager_grants' | 'authentication'>,
): TeamCapabilities => {
  const session = identity.authentication.kind === 'session'
  const profileCanRead =
    identity.profile === 'project_manager' ||
    identity.profile === 'people_admin' ||
    identity.profile === 'executive_manager' ||
    identity.profile === 'administrator'
  const canRead =
    profileCanRead &&
    (session ||
      (identity.authentication.kind === 'token' &&
        identity.authentication.scopes.includes('team:read')))
  return {
    canRead,
    canManagePeople:
      session &&
      (identity.profile === 'people_admin' ||
        identity.profile === 'executive_manager' ||
        identity.profile === 'administrator'),
    canChangeProfile: session && identity.profile === 'administrator',
    canAppendBillableRate:
      session &&
      (identity.profile === 'administrator' ||
        (identity.profile === 'project_manager' &&
          identity.manager_grants.includes('billable_rates_manager'))),
    canAppendCostRate: session && identity.profile === 'administrator',
  }
}

export type TeamProfile = TeamPerson['profile']

export const teamProfileOptions: readonly {
  readonly value: TeamProfile
  readonly label: string
  readonly description: string
}[] = [
  {
    value: 'member',
    label: 'Member',
    description: 'Tracks time and expenses on assigned projects.',
  },
  {
    value: 'project_manager',
    label: 'Project manager',
    description: 'Manages assigned projects and the people assigned to them.',
  },
  {
    value: 'people_admin',
    label: 'People administrator',
    description: 'Manages people, assignments, and reminder settings.',
  },
  {
    value: 'accounting',
    label: 'Accounting',
    description: 'Works with invoices and billable financial information.',
  },
  {
    value: 'executive_manager',
    label: 'Executive manager',
    description: 'Reviews organization work, reports, and billable information.',
  },
  {
    value: 'administrator',
    label: 'Administrator',
    description: 'Has full organization administration access.',
  },
]

const parseDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

export const shiftTeamDate = (value: string, days: number): string => {
  const date = parseDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export const teamWeekRange = (
  within: string,
  weekStartDay: 'saturday' | 'sunday' | 'monday' = 'monday',
): { readonly from: string; readonly to: string } => {
  const date = parseDate(within)
  const startDay = weekStartDay === 'saturday' ? 6 : weekStartDay === 'sunday' ? 0 : 1
  const offset = (date.getUTCDay() - startDay + 7) % 7
  const from = shiftTeamDate(within, -offset)
  return { from, to: shiftTeamDate(from, 6) }
}

export const teamWeekLabel = (from: string, to: string): string => {
  const first = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parseDate(from))
  const last = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parseDate(to))
  return `${first} – ${last}`
}

export const teamHours = (seconds: number): string =>
  `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(seconds / 3_600)}h`

export const teamUtilization = (partsPerMillion: number | null): string =>
  partsPerMillion === null
    ? 'No capacity'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(partsPerMillion / 10_000)}%`

export const teamMoney = (amountCents: number): string =>
  `${Math.floor(amountCents / 100).toLocaleString('en-US')}.${String(amountCents % 100).padStart(2, '0')}/hour`

export const ratePeriod = (rate: Pick<UserRate, 'start_date' | 'end_date'>): string => {
  const start = rate.start_date ?? 'Beginning'
  return `${start} – ${rate.end_date ?? 'Ongoing'}`
}

export const teamPersonIdFromPathname = (pathname: string): number | null => {
  const match = /^\/team\/([1-9][0-9]*)\/?$/u.exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export const parseTeamMoneyCents = (value: string): number => {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u.test(value)) {
    throw new Error('Enter a non-negative amount with no more than two decimals.')
  }
  const [whole, fraction = ''] = value.split('.')
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('That amount is too large.')
  return Number(cents)
}

export const parseTeamCapacitySeconds = (value: string): number => {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(value)) {
    throw new Error('Capacity must be a non-negative number of hours.')
  }
  const [whole, fraction = ''] = value.split('.')
  const scale = 10n ** BigInt(fraction.length)
  const numerator = BigInt(whole!) * scale + BigInt(fraction === '' ? '0' : fraction)
  const scaledSeconds = numerator * 3_600n
  if (scaledSeconds % scale !== 0n) {
    throw new Error('Capacity must resolve to a whole number of seconds.')
  }
  const seconds = scaledSeconds / scale
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('That capacity is too large.')
  return Number(seconds)
}
