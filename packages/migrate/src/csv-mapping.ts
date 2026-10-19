import { createHash } from 'node:crypto'
import { nameKey } from './csv-contract.js'

/**
 * How a file's people, clients, projects and tasks become this instance's
 * (issue 1012). A name the mapping does not mention is looked up as written.
 *
 *   {
 *     "people":   { "ann@old.example": "ann@here.example",
 *                   "bo@old.example": { "create": { "firstName": "Bo", "lastName": "Lee" } } },
 *     "clients":  { "Acme Inc": "Acme" },
 *     "projects": { "Acme Inc": { "Web": "Website" } },
 *     "tasks":    { "Dev": "Development" }
 *   }
 *
 * A person is never created unless the mapping says so, because a person is
 * somebody who can be signed in as. Clients, projects and tasks that do not
 * exist are created, as plain organization data, and the dry-run lists them.
 * Names compare without case or surplus space; the stored form is normalized
 * so the same mapping always has the same hash.
 */
export interface CsvMapping {
  people: Record<string, string | { create: { firstName: string; lastName: string } }>
  clients: Record<string, string>
  projects: Record<string, Record<string, string>>
  tasks: Record<string, string>
}

export class CsvMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvMappingError'
  }
}

export const MAX_MAPPING_BYTES = 1024 * 1024
const MAX_NAME = 255

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NAME) {
    throw new CsvMappingError(
      `${where} must be a non-empty string of at most ${MAX_NAME} characters.`,
    )
  }
  return value
}

const section = (value: unknown, name: string): Record<string, unknown> => {
  if (value === undefined) return {}
  if (!isObject(value)) throw new CsvMappingError(`${name} must be an object.`)
  return value
}

const emptyRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

export const emptyMapping = (): CsvMapping => ({
  people: emptyRecord(),
  clients: emptyRecord(),
  projects: emptyRecord(),
  tasks: emptyRecord(),
})

export const parseMapping = (source: string): CsvMapping => {
  if (Buffer.byteLength(source) > MAX_MAPPING_BYTES) {
    throw new CsvMappingError('The mapping file is larger than 1 MiB.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new CsvMappingError('The mapping file is not valid JSON.')
  }
  if (!isObject(parsed)) throw new CsvMappingError('The mapping must be a JSON object.')
  for (const key of Object.keys(parsed)) {
    if (!['people', 'clients', 'projects', 'tasks'].includes(key)) {
      throw new CsvMappingError(`Unknown mapping section ${JSON.stringify(key)}.`)
    }
  }
  const mapping = emptyMapping()
  for (const [from, to] of Object.entries(section(parsed.people, 'people'))) {
    const email = text(from, 'A people key').trim().toLowerCase()
    if (isObject(to)) {
      const create = to.create
      if (Object.keys(to).length !== 1 || !isObject(create)) {
        throw new CsvMappingError(`people ${from} must be an email or { "create": { ... } }.`)
      }
      if (Object.keys(create).some((key) => key !== 'firstName' && key !== 'lastName')) {
        throw new CsvMappingError(`people ${from} create takes only firstName and lastName.`)
      }
      mapping.people[email] = {
        create: {
          firstName: text(create.firstName, `people ${from} firstName`).trim(),
          lastName: text(create.lastName, `people ${from} lastName`).trim(),
        },
      }
    } else {
      mapping.people[email] = text(to, `people ${from}`).trim().toLowerCase()
    }
  }
  for (const name of ['clients', 'tasks'] as const) {
    for (const [from, to] of Object.entries(section(parsed[name], name))) {
      mapping[name][nameKey(text(from, `A ${name} key`))] = text(to, `${name} ${from}`)
    }
  }
  for (const [client, projects] of Object.entries(section(parsed.projects, 'projects'))) {
    if (!isObject(projects)) throw new CsvMappingError(`projects ${client} must be an object.`)
    const byProject = emptyRecord<string>()
    for (const [from, to] of Object.entries(projects)) {
      byProject[nameKey(text(from, 'A projects key'))] = text(to, `projects ${client} ${from}`)
    }
    mapping.projects[nameKey(text(client, 'A projects client key'))] = byProject
  }
  return mapping
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted)
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    )
  }
  return value
}

/** The form stored with a run, and the hash a retry is compared by. */
export const canonicalMapping = (mapping: CsvMapping): { json: string; sha256: string } => {
  const json = JSON.stringify(sorted(mapping))
  return { json, sha256: createHash('sha256').update(json).digest('hex') }
}
