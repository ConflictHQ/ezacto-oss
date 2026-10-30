import type { ImportMapping, SourceEntity } from './contract.js'
import { CsvUiError } from './errors.js'

type Values = ImportMapping['mapping']
export type MappingEdit =
  | { readonly action: 'existing'; readonly id: number }
  | { readonly action: 'create'; readonly name: string }
  | { readonly action: 'person'; readonly firstName: string; readonly lastName: string }
  | { readonly action: 'source' }

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const dictionary = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = Object.assign(Object.create(null) as Record<string, unknown>, object(parent[key]) ?? {})
  parent[key] = value
  return value
}
const name = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()
const nonempty = (value: string): string => {
  const text = value.trim()
  if (!text || text.length > 255) throw new CsvUiError('Enter a name from 1 to 255 characters.')
  return text
}

/** Edits the real browser mapping JSON; opaque source keys bind exact ID choices. */
export const editMapping = (input: Values, source: SourceEntity, edit: MappingEdit): Values => {
  if (source.state === 'excluded') throw new CsvUiError('Re-include this source before changing its mapping.')
  const next = structuredClone(input)
  const ids = dictionary(dictionary(next, 'destinationIds'), source.kind)
  const values = dictionary(next, source.kind)
  const key = source.kind === 'people' ? source.label.trim().toLowerCase() : name(source.label)
  let target = values
  if (source.kind === 'projects') {
    const client = source.parents.find(parent => parent.kind === 'clients')
    if (!client) throw new CsvUiError('This project is missing its source client. Refresh the preview.')
    target = dictionary(values, name(client.label))
  }
  delete ids[source.source_key]
  delete target[key]
  if (edit.action === 'existing') {
    if (!Number.isSafeInteger(edit.id) || edit.id < 1) throw new CsvUiError('Choose an exact destination record.')
    ids[source.source_key] = edit.id
  } else if (edit.action === 'person') {
    if (source.kind !== 'people') throw new CsvUiError('This creation choice is not valid for this source.')
    target[key] = { create: { firstName: nonempty(edit.firstName), lastName: nonempty(edit.lastName) } }
  } else if (edit.action === 'create') {
    if (source.kind === 'people') throw new CsvUiError('New people need explicit first and last names.')
    target[key] = nonempty(edit.name)
  }
  if (Object.keys(target).length === 0 && source.kind === 'projects') {
    const client = source.parents.find(parent => parent.kind === 'clients')!
    delete values[name(client.label)]
  }
  if (Object.keys(values).length === 0) delete next[source.kind]
  const destinations = object(next['destinationIds'])!
  if (Object.keys(ids).length === 0) delete destinations[source.kind]
  if (Object.keys(destinations).length === 0) delete next['destinationIds']
  return next
}

export const currentCreation = (mapping: Values, source: SourceEntity): Record<string, unknown> | string | null => {
  let section = object(mapping[source.kind])
  if (!section) return null
  if (source.kind === 'projects') {
    const client = source.parents.find(parent => parent.kind === 'clients')
    section = client ? object(section[name(client.label)]) : null
  }
  if (!section) return null
  const key = source.kind === 'people' ? source.label.trim().toLowerCase() : name(source.label)
  if (!Object.hasOwn(section, key)) return null
  const value = section[key]
  return typeof value === 'string' ? value : object(object(value)?.create)
}
