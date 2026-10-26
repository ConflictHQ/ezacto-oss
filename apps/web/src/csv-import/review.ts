import type { ImportPreview } from './contract.js'
import { CsvUiError } from './errors.js'

export interface Review {
  readonly preview: ImportPreview
  readonly actor: string
}

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Later UI edits cannot mutate the immutable preview the acknowledgements cover. */
export const startReview = (preview: ImportPreview, actor: string): Review => ({
  preview: freeze(structuredClone(preview)), actor,
})

export const afterSessionChange = (review: Review, actor: string | null): Review | null =>
  actor === review.actor ? review : null

export const physicalLines = (text: string): number[] => {
  if (text.trim() === '') return []
  const values = text.split(',').map(value => value.trim())
  if (values.length > 50_000 || values.some(value => !/^[1-9][0-9]*$/.test(value) || Number(value) < 2 || !Number.isSafeInteger(Number(value)))) {
    throw new CsvUiError('Enter comma-separated data line numbers of 2 or more.')
  }
  return [...new Set(values.map(Number))].sort((left, right) => left - right)
}
