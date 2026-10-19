import type { GeneralResourceFilters } from '@ezacto/core'
import type { TimeEntryFilters } from '../resources/tracked-repository.js'
import { validationError, type FieldError } from '../errors.js'
import {
  harvestDefaultPerPage,
  harvestMaximumPerPage,
  type HarvestPageRequest,
} from './pagination.js'

export type HarvestListResource = 'clients' | 'projects' | 'tasks' | 'users'

/** Lists that take the same parameters as the general resources they page over. */
export type HarvestGeneralListResource = HarvestListResource | 'project_assignments'

/** The Harvest list parameters each covered resource accepts, besides paging. */
const filterParameters: Readonly<Record<HarvestGeneralListResource, readonly string[]>> = {
  clients: ['is_active', 'updated_since'],
  projects: ['is_active', 'client_id', 'updated_since'],
  tasks: ['is_active', 'updated_since'],
  users: ['is_active', 'updated_since'],
  project_assignments: ['is_active', 'updated_since'],
}

export interface HarvestListQuery {
  filters: GeneralResourceFilters
  page: HarvestPageRequest
  /** The accepted parameters other than page and per_page, as sent, for links. */
  echo: ReadonlyArray<readonly [string, string]>
}

const positiveInteger = /^[1-9]\d{0,9}$/
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

const readPaging = (
  params: URLSearchParams,
  reject: (field: string, message: string) => void,
): HarvestPageRequest => {
  let page = 1
  const rawPage = params.get('page')
  if (rawPage !== null) {
    if (positiveInteger.test(rawPage)) page = Number(rawPage)
    else reject('page', 'page must be a positive integer.')
  }
  let perPage = harvestDefaultPerPage
  const rawPerPage = params.get('per_page')
  if (rawPerPage !== null) {
    if (positiveInteger.test(rawPerPage) && Number(rawPerPage) <= harvestMaximumPerPage)
      perPage = Number(rawPerPage)
    else reject('per_page', `per_page must be between 1 and ${harvestMaximumPerPage}.`)
  }
  return { page, perPage }
}

/**
 * Map Harvest-shaped list parameters onto the canonical filters. Unknown
 * parameters are ignored, as Harvest does; malformed known ones are refused
 * with a field error rather than guessed at.
 */
export const parseHarvestListQuery = (
  resource: HarvestGeneralListResource,
  params: URLSearchParams,
): HarvestListQuery => {
  const errors: FieldError[] = []
  const reject = (field: string, message: string): void => {
    errors.push({ field, code: 'invalid', message })
  }
  const filters: { -readonly [K in keyof GeneralResourceFilters]: GeneralResourceFilters[K] } = {}
  const echo: Array<readonly [string, string]> = []
  for (const name of filterParameters[resource]) {
    const value = params.get(name)
    if (value === null) continue
    echo.push([name, value])
    if (name === 'is_active') {
      if (value === 'true') filters.isActive = true
      else if (value === 'false') filters.isActive = false
      else reject(name, 'is_active must be true or false.')
    } else if (name === 'client_id') {
      if (positiveInteger.test(value)) filters.clientId = Number(value)
      else reject(name, 'client_id must be a positive integer.')
    } else if (!instant.test(value)) {
      reject(name, 'updated_since must be an ISO 8601 UTC timestamp.')
    } else {
      // Canonical instants carry milliseconds; Harvest callers send whole seconds.
      filters.updatedSince = new Date(value).toISOString()
    }
  }
  const page = readPaging(params, reject)
  if (errors.length > 0) throw validationError(errors)
  return { filters, page, echo }
}

export interface HarvestTimeEntryQuery {
  filters: TimeEntryFilters
  page: HarvestPageRequest
  echo: ReadonlyArray<readonly [string, string]>
}

const calendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

const timeEntryParameters = [
  'user_id',
  'client_id',
  'project_id',
  'task_id',
  'is_billed',
  'is_running',
  'approval_status',
  'external_reference_id',
  'updated_since',
  'from',
  'to',
] as const

/**
 * Map Harvest's time_entries parameters onto the canonical filters. As for the
 * other lists, unknown parameters are ignored and malformed known ones refused.
 * Who may name another person, or filter by invoice, is the route's to decide.
 */
export const parseHarvestTimeEntryQuery = (params: URLSearchParams): HarvestTimeEntryQuery => {
  const errors: FieldError[] = []
  const reject = (field: string, message: string): void => {
    errors.push({ field, code: 'invalid', message })
  }
  const filters: { -readonly [K in keyof TimeEntryFilters]: TimeEntryFilters[K] } = {}
  const echo: Array<readonly [string, string]> = []
  const integer = (name: string, value: string): number | undefined => {
    if (positiveInteger.test(value)) return Number(value)
    reject(name, `${name} must be a positive integer.`)
    return undefined
  }
  const boolean = (name: string, value: string): boolean | undefined => {
    if (value === 'true') return true
    if (value === 'false') return false
    reject(name, `${name} must be true or false.`)
    return undefined
  }
  for (const name of timeEntryParameters) {
    const value = params.get(name)
    if (value === null) continue
    echo.push([name, value])
    if (name === 'user_id' || name === 'client_id' || name === 'project_id' || name === 'task_id') {
      const id = integer(name, value)
      if (id === undefined) continue
      if (name === 'user_id') filters.userId = id
      else if (name === 'client_id') filters.clientId = id
      else if (name === 'project_id') filters.projectId = id
      else filters.taskId = id
    } else if (name === 'is_billed' || name === 'is_running') {
      const flagValue = boolean(name, value)
      if (flagValue === undefined) continue
      if (name === 'is_billed') filters.isBilled = flagValue
      else filters.isRunning = flagValue
    }
    else if (name === 'approval_status') {
      if (value === 'unsubmitted' || value === 'submitted' || value === 'approved')
        filters.approvalStatus = value
      else reject(name, 'approval_status must be unsubmitted, submitted or approved.')
    } else if (name === 'external_reference_id') {
      if (value === '') reject(name, 'external_reference_id must not be empty.')
      else filters.externalReferenceId = value
    } else if (name === 'updated_since') {
      if (instant.test(value)) filters.updatedSince = new Date(value).toISOString()
      else reject(name, 'updated_since must be an ISO 8601 UTC timestamp.')
    } else if (calendarDate(value)) {
      if (name === 'from') filters.from = value
      else filters.to = value
    } else reject(name, `${name} must be a date as YYYY-MM-DD.`)
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to)
    reject('to', 'to must not precede from.')
  const page = readPaging(params, reject)
  if (errors.length > 0) throw validationError(errors)
  return { filters, page, echo }
}
