import type { ApplyCommand, ImportPreview } from './contract.js'
import { CsvUiError } from './errors.js'

export interface Review {
  readonly preview: ImportPreview
  readonly actor: string
  reviewed: boolean
  exclusions: boolean
  destinationDifference: boolean
  newPeople: boolean
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
  reviewed: false, exclusions: false, destinationDifference: false, newPeople: false,
})

export const blockers = (review: Review): string[] => {
  const { tallies, choices } = review.preview
  const reasons: string[] = []
  if (tallies.file_error_count > 0) reasons.push('Correct the file errors and upload a valid CSV. File errors cannot be excluded.')
  if (tallies.rejected_row_count > 0) reasons.push(`Resolve or explicitly exclude all ${tallies.rejected_row_count} rejected rows, then review the new preview.`)
  if (tallies.selected_rows === 0) reasons.push('Select at least one time row before sealing this dataset.')
  if (!review.reviewed) reasons.push('Review the destination, file, dataset, mappings and exact selected rows.')
  if (choices.excluded_lines.length > 0 && !review.exclusions) reasons.push(`Review all ${choices.excluded_lines.length} excluded physical lines.`)
  if (tallies.destination_delta_seconds !== 0 && !review.destinationDifference) reasons.push('Review the difference between source and destination seconds, including imported history.')
  if (tallies.people.new > 0 && !review.newPeople) reasons.push('Review the new inactive people; no one will be invited or activated.')
  return reasons
}

export const afterSessionChange = (review: Review, actor: string | null): Review | null =>
  actor === review.actor ? review : null

export const applyCommand = (review: Review, commandId: string, version = review.preview.run.version): ApplyCommand => {
  const reasons = blockers(review)
  if (reasons.length) throw new CsvUiError(reasons.join(' '))
  const { preview } = review
  return {
    preview_id: preview.preview_id, command_id: commandId, version,
    expected_selected_rows: preview.tallies.selected_rows,
    expected_source_seconds: preview.tallies.source_seconds,
    expected_destination_seconds: preview.tallies.destination_seconds,
    acknowledge_exclusions: review.exclusions,
    acknowledge_destination_difference: review.destinationDifference,
    acknowledge_new_people: review.newPeople,
  }
}

export const physicalLines = (text: string): number[] => {
  if (text.trim() === '') return []
  const values = text.split(',').map(value => value.trim())
  if (values.length > 50_000 || values.some(value => !/^[1-9][0-9]*$/.test(value) || Number(value) < 2 || !Number.isSafeInteger(Number(value)))) {
    throw new CsvUiError('Enter comma-separated data line numbers of 2 or more.')
  }
  return [...new Set(values.map(Number))].sort((left, right) => left - right)
}
