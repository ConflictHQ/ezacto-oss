import { CsvBrowserPlannerError } from './csv-browser-errors.js'
import { sha256Hex, utf8ByteLength } from './portable-hash.js'
import { nameKey, type CsvRow } from './csv-contract.js'
import { MAX_MAPPING_BYTES, parseMapping, type CsvMapping } from './csv-mapping.js'

export interface CsvBrowserDestinationIds {
  people: Record<string, number>
  clients: Record<string, number>
  projects: Record<string, number>
  tasks: Record<string, number>
}
export interface CsvBrowserMapping extends CsvMapping {
  destinationIds?: CsvBrowserDestinationIds
}

/** Opaque source keys retain parent boundaries even when names contain delimiters. */
export const csvSourceEntityKeys = (
  row: Pick<CsvRow, 'personEmail' | 'client' | 'project' | 'task'>,
) => ({
  people: sha256Hex(JSON.stringify(['person', row.personEmail])),
  clients: sha256Hex(JSON.stringify(['client', nameKey(row.client)])),
  projects: sha256Hex(JSON.stringify(['project', nameKey(row.client), nameKey(row.project)])),
  tasks: sha256Hex(
    JSON.stringify(['task', nameKey(row.client), nameKey(row.project), nameKey(row.task)]),
  ),
})

/** Browser-only extension. The existing CLI JSON parser continues refusing this section. */
export const parseBrowserMapping = (source: string): CsvBrowserMapping => {
  if (utf8ByteLength(source) > MAX_MAPPING_BYTES)
    throw new CsvBrowserPlannerError('mapping_too_large')
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    throw new CsvBrowserPlannerError('mapping_invalid')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new CsvBrowserPlannerError('mapping_invalid')
  const { destinationIds, ...legacy } = raw as Record<string, unknown>
  let mapping: CsvBrowserMapping
  try {
    mapping = parseMapping(JSON.stringify(legacy))
  } catch (cause) {
    throw new CsvBrowserPlannerError('mapping_invalid', { cause })
  }
  if (destinationIds === undefined) return mapping
  if (
    destinationIds === null ||
    typeof destinationIds !== 'object' ||
    Array.isArray(destinationIds)
  )
    throw new CsvBrowserPlannerError('mapping_invalid')
  const sections = destinationIds as Record<string, unknown>
  if (
    Object.keys(sections).some((key) => !['people', 'clients', 'projects', 'tasks'].includes(key))
  )
    throw new CsvBrowserPlannerError('mapping_invalid')
  const ids: CsvBrowserDestinationIds = {
    people: Object.create(null),
    clients: Object.create(null),
    projects: Object.create(null),
    tasks: Object.create(null),
  }
  for (const section of ['people', 'clients', 'projects', 'tasks'] as const) {
    const values = sections[section] ?? {}
    if (values === null || typeof values !== 'object' || Array.isArray(values))
      throw new CsvBrowserPlannerError('mapping_invalid')
    for (const [key, id] of Object.entries(values)) {
      if (
        !/^[0-9a-f]{64}$/.test(key) ||
        typeof id !== 'number' ||
        !Number.isSafeInteger(id) ||
        id <= 0
      )
        throw new CsvBrowserPlannerError('mapping_invalid')
      ids[section][key] = id
    }
  }
  if (Object.values(ids).some((section) => Object.keys(section).length > 0))
    mapping.destinationIds = ids
  return mapping
}

export const assertBrowserMappingSources = (
  mapping: CsvBrowserMapping,
  rows: readonly CsvRow[],
): void => {
  if (!mapping.destinationIds) return
  const known = {
    people: new Set<string>(),
    clients: new Set<string>(),
    projects: new Set<string>(),
    tasks: new Set<string>(),
  }
  for (const row of rows) {
    const keys = csvSourceEntityKeys(row)
    for (const section of ['people', 'clients', 'projects', 'tasks'] as const)
      known[section].add(keys[section])
  }
  for (const section of ['people', 'clients', 'projects', 'tasks'] as const) {
    for (const [key, id] of Object.entries(mapping.destinationIds[section] ?? {})) {
      if (!known[section].has(key) || !Number.isSafeInteger(id) || id <= 0)
        throw new CsvBrowserPlannerError('mapping_source_unknown')
    }
  }
}
