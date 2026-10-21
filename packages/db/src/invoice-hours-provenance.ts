import { hoursToTheHundredth } from '@ezacto/core'
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null
const parse = (text: string | null): ObjectValue | null => {
  try {
    return text === null ? null : object(JSON.parse(text))
  } catch {
    return null
  }
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
/** Immutable generation receipts establish units and identity; descriptions,
 * current rates and free-text line kinds never establish a time-entry link. */
export const invoiceLineTimeOrigins = (receipt: {
  requestJson: string | null
  sourceJson: string | null
  linesJson: string | null
}): Map<number, number[]> => {
  const found = new Map<number, number[]>()
  const source = parse(receipt.sourceJson),
    manifest = parse(receipt.linesJson),
    request = parse(receipt.requestJson)
  if (
    source?.schema_version !== 1 ||
    manifest?.schema_version !== 1 ||
    !Array.isArray(source.time_entries) ||
    !Array.isArray(manifest.lines)
  )
    return found
  const entries = source.time_entries.map(object),
    lines = manifest.lines.map(object)
  if (
    entries.some(
      (entry) =>
        !entry ||
        !positive(entry.id) ||
        !positive(entry.project_id) ||
        !positive(entry.user_id) ||
        !positive(entry.task_id) ||
        !Number.isSafeInteger(entry.rounded_seconds),
    ) ||
    lines.some((line) => !line || !positive(line.id) || !Number.isSafeInteger(line.position))
  )
    return found
  const originals = entries as (ObjectValue & {
    id: number
    project_id: number
    user_id: number
    task_id: number
    rounded_seconds: number
  })[]
  const originalLines = lines as (ObjectValue & { id: number; position: number })[]
  const byId = new Map(originals.map((entry) => [entry.id, entry]))
  if (byId.size !== originals.length) return found
  if (originalLines.some((line) => 'time_entry_ids' in line)) {
    for (const line of originalLines) {
      const ids = line.time_entry_ids
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !positive(id) || byId.get(id)?.project_id !== line.project_id)
      )
        continue
      found.set(line.id, ids as number[])
    }
    return found
  }
  // Older ordinary tracked invoices retained the exact source order, grouping
  // mode and original line positions/quantities. Reconstruct that grouping only
  // when every group matches; never backfill or use descriptions/names. Banded
  // fees are deliberately excluded from this legacy reconstruction.
  const summary = request?.time_summary_type
  if (
    request?.kind === 'banded' ||
    request?.kind === 'free_form' ||
    !['project', 'task', 'people', 'detailed'].includes(String(summary))
  )
    return found
  const groups = new Map<string, typeof originals>()
  for (const entry of originals) {
    const key =
      summary === 'project'
        ? `${entry.project_id}`
        : summary === 'task'
          ? `${entry.project_id}:${entry.task_id}`
          : summary === 'people'
            ? `${entry.project_id}:${entry.user_id}`
            : `${entry.id}`
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  for (const projectId of new Set(originals.map((entry) => entry.project_id))) {
    const ownGroups = [...groups.values()].filter((group) => group[0]!.project_id === projectId)
    const ownLines = originalLines
      .filter((line) => line.project_id === projectId && line.kind === 'Service')
      .sort((a, b) => a.position - b.position)
    if (
      ownGroups.length !== ownLines.length ||
      ownLines.some(
        (line, index) =>
          typeof line.quantity !== 'number' ||
          line.quantity !==
            hoursToTheHundredth(
              ownGroups[index]!.reduce((sum, entry) => sum + entry.rounded_seconds, 0),
            ),
      )
    )
      continue
    ownLines.forEach((line, index) =>
      found.set(
        line.id,
        ownGroups[index]!.map((entry) => entry.id),
      ),
    )
  }
  return found
}
