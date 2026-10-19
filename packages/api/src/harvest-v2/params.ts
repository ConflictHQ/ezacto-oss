import type { GeneralResourceFilters } from '@ezacto/core'
import { validationError, type FieldError } from '../errors.js'
import {
  harvestDefaultPerPage,
  harvestMaximumPerPage,
  type HarvestPageRequest,
} from './pagination.js'

export type HarvestListResource = 'clients' | 'projects' | 'tasks' | 'users'

/** The Harvest list parameters each covered resource accepts, besides paging. */
const filterParameters: Readonly<Record<HarvestListResource, readonly string[]>> = {
  clients: ['is_active', 'updated_since'],
  projects: ['is_active', 'client_id', 'updated_since'],
  tasks: ['is_active', 'updated_since'],
  users: ['is_active', 'updated_since'],
}

export interface HarvestListQuery {
  filters: GeneralResourceFilters
  page: HarvestPageRequest
  /** The accepted parameters other than page and per_page, as sent, for links. */
  echo: ReadonlyArray<readonly [string, string]>
}

const positiveInteger = /^[1-9]\d{0,9}$/
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/**
 * Map Harvest-shaped list parameters onto the canonical filters. Unknown
 * parameters are ignored, as Harvest does; malformed known ones are refused
 * with a field error rather than guessed at.
 */
export const parseHarvestListQuery = (
  resource: HarvestListResource,
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
  if (errors.length > 0) throw validationError(errors)
  return { filters, page: { page, perPage }, echo }
}
