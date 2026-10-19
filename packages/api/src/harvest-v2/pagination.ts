/**
 * Harvest v2 page-number pagination. Compat quirk: lives in the shim only; the
 * native API pages by signed cursor (../pagination.ts).
 */
export const harvestDefaultPerPage = 2000
export const harvestMaximumPerPage = 2000

export interface HarvestPageRequest {
  page: number
  perPage: number
}

export interface HarvestPageLinks {
  first: string
  next: string | null
  previous: string | null
  last: string
}

export type HarvestPage<Key extends string, Output> = { [K in Key]: Output[] } & {
  per_page: number
  total_pages: number
  total_entries: number
  next_page: number | null
  previous_page: number | null
  page: number
  links: HarvestPageLinks
}

/** The offset and row count a repository read needs for a Harvest page. */
export const harvestPageWindow = (
  request: HarvestPageRequest,
): { offset: number; take: number } => ({
  offset: (request.page - 1) * request.perPage,
  take: request.perPage,
})

/**
 * Wrap one page of already-serialized rows. `totalEntries` is the size of the
 * whole filtered collection, as Harvest reports it. `path` is the request path
 * (for example `/harvest/v2/clients`); `query` carries the other query
 * parameters, which the links preserve in order.
 */
export const harvestPage = <Key extends string, Output>(
  key: Key,
  rows: readonly Output[],
  totalEntries: number,
  request: HarvestPageRequest,
  path: string,
  query: ReadonlyArray<readonly [string, string]> = [],
): HarvestPage<Key, Output> => {
  const totalPages = Math.max(1, Math.ceil(totalEntries / request.perPage))
  const link = (page: number): string => {
    const params = new URLSearchParams()
    for (const [name, value] of query) params.append(name, value)
    params.set('page', String(page))
    params.set('per_page', String(request.perPage))
    return `${path}?${params.toString()}`
  }
  const next = request.page < totalPages ? request.page + 1 : null
  const previous = request.page > 1 ? request.page - 1 : null
  return {
    [key]: [...rows],
    per_page: request.perPage,
    total_pages: totalPages,
    total_entries: totalEntries,
    next_page: next,
    previous_page: previous,
    page: request.page,
    links: {
      first: link(1),
      next: next === null ? null : link(next),
      previous: previous === null ? null : link(previous),
      last: link(totalPages),
    },
  } as HarvestPage<Key, Output>
}
