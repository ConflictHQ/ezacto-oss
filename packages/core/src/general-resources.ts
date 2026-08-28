export type GeneralResourceKind =
  | 'clients'
  | 'contacts'
  | 'projects'
  | 'tasks'
  | 'task-assignments'
  | 'user-assignments'
  | 'users'
  | 'roles'

export type UserRateKind = 'billable' | 'cost'

export type GeneralScalar = string | number | boolean | null
export type GeneralValue = GeneralScalar | readonly (string | number)[]

export interface GeneralResourceRecord {
  id: number
  createdAt: string
  updatedAt: string
  [field: string]: GeneralValue
}

export interface UserRateRecord extends GeneralResourceRecord {
  userId: number
  amountCents: number
  startDate: string | null
  endDate: string | null
}

export interface GeneralResourceFilters {
  isActive?: boolean
  updatedSince?: string
  clientId?: number
  projectId?: number
  taskId?: number
  userId?: number
  parentClientId?: number
  billToClientId?: number
  profile?: string
  isContractor?: boolean
}

export interface GeneralListWindow {
  afterId: number | null
  throughId: number
  take: number
}

export type GeneralMutationInput = Readonly<Record<string, GeneralValue>>

export type GeneralResourceErrorCode =
  | 'not_found'
  | 'conflict'
  | 'in_use'
  | 'invalid_reference'
  | 'invalid_input'
  | 'immutable'

/** Stable domain/port failure. Adapters must not leak engine-specific errors above this seam. */
export class GeneralResourceError extends Error {
  readonly code: GeneralResourceErrorCode
  readonly field: string | null

  constructor(code: GeneralResourceErrorCode, message: string, field: string | null = null) {
    super(message)
    this.name = 'GeneralResourceError'
    this.code = code
    this.field = field
  }
}

/** DB-free application port used by every native general-resource route. */
export interface GeneralResourceRepository {
  highWatermark(
    kind: GeneralResourceKind,
    filters: Readonly<GeneralResourceFilters>,
  ): Promise<number | null>
  list(
    kind: GeneralResourceKind,
    filters: Readonly<GeneralResourceFilters>,
    window: Readonly<GeneralListWindow>,
  ): Promise<readonly GeneralResourceRecord[]>
  get(kind: GeneralResourceKind, id: number): Promise<GeneralResourceRecord>
  create(
    kind: GeneralResourceKind,
    input: GeneralMutationInput,
    now: string,
  ): Promise<GeneralResourceRecord>
  update(
    kind: GeneralResourceKind,
    id: number,
    input: GeneralMutationInput,
    now: string,
  ): Promise<GeneralResourceRecord>
  remove(kind: GeneralResourceKind, id: number, now: string): Promise<void>
  highWatermarkRates(userId: number, kind: UserRateKind): Promise<number | null>
  listRates(
    userId: number,
    kind: UserRateKind,
    window: Readonly<GeneralListWindow>,
  ): Promise<readonly UserRateRecord[]>
  getRate(userId: number, kind: UserRateKind, id: number): Promise<UserRateRecord>
  appendRate(
    userId: number,
    kind: UserRateKind,
    input: Readonly<{ amountCents: number; startDate: string | null }>,
    now: string,
  ): Promise<UserRateRecord>
}
