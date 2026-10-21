/**
 * Whether an invoice's billed hours agree with the time entries it claims
 * (issue 924).
 *
 * Editing a line's quantity does not touch the entries linked to the invoice
 * (`time_entries.invoice_id`), so the two can drift: the hours report then
 * lists more or fewer hours than the invoice charged for. This is the
 * comparison, as a pure function so the same answer can be read by the API, the
 * editor and the send flow.
 *
 * Native readers provide immutable generation origins for exact line comparisons.
 * Fees, expenses and unknown legacy units are excluded explicitly. Callers
 * already supplying known hour quantities can also request the original
 * project aggregate by omitting provenance metadata.
 *
 * Compared in whole seconds, never floating hours: a quantity of 7.25 hours
 * against 26 100 seconds of entries must not read as a phantom difference.
 */

export interface ReconciliationEntry {
  readonly id?: number
  readonly userId?: number
  readonly userName?: string
  readonly spentDate?: string
  readonly projectId: number
  readonly projectName: string | null
  /** The billed figure: `rounded_seconds`, the same one the journal totals. */
  readonly seconds: number
}

export interface ReconciliationLine {
  /** Exact generation provenance; current linked entries are a subset after release. */
  readonly timeEntryIds?: readonly number[]
  /** false for a fee/expense or a legacy line whose units cannot be established. */
  readonly comparable?: boolean
  readonly id: number
  readonly position: number
  readonly description: string | null
  readonly projectId: number | null
  readonly projectName: string | null
  /** Hours, as the invoice line states them. */
  readonly quantity: number
}

/** 0.01 hour: the precision a quantity is typed at. */
export const defaultReconciliationToleranceSeconds = 36

export type ReconciliationStatus =
  | 'matched'
  | 'billed_below_linked'
  | 'billed_above_linked'
  | 'not_comparable'

export interface ReconciliationFigures {
  readonly linkedSeconds: number
  readonly billedSeconds: number
  /** Billed minus linked; negative when the invoice charged for less than it links. */
  readonly differenceSeconds: number
  readonly status: ReconciliationStatus
}

export interface ProjectReconciliation extends ReconciliationFigures {
  readonly toleranceSeconds?: number
  readonly projectId: number
  readonly projectName: string | null
}

export interface LineHoursReconciliation extends ReconciliationFigures {
  readonly lineId: number
  readonly projectId: number | null
  readonly entryIds: readonly number[]
}
export interface InvoiceHoursReconciliation extends ReconciliationFigures {
  readonly lines: readonly LineHoursReconciliation[]
  readonly entries: readonly ReconciliationEntry[]
  readonly comparisonComplete: boolean
  /** A known line can differ even when opposite differences cancel in totals. */
  readonly hasMismatch: boolean
  readonly notComparedEntryIds: readonly number[]
  readonly invoiceVersion?: number
  readonly invoiceState?: string
  readonly toleranceSeconds: number
  readonly totalToleranceSeconds: number
  readonly projects: readonly ProjectReconciliation[]
  /** Lines that could not be attributed to a project, left out of every figure. */
  readonly notCompared: readonly ReconciliationLine[]
}

const figuresFor = (
  linkedSeconds: number,
  billedSeconds: number,
  toleranceSeconds: number,
): ReconciliationFigures => {
  const differenceSeconds = billedSeconds - linkedSeconds
  return {
    linkedSeconds,
    billedSeconds,
    differenceSeconds,
    status:
      Math.abs(differenceSeconds) <= toleranceSeconds
        ? 'matched'
        : differenceSeconds < 0
          ? 'billed_below_linked'
          : 'billed_above_linked',
  }
}

export const reconcileInvoiceHours = (input: {
  readonly entries: readonly ReconciliationEntry[]
  readonly lines: readonly ReconciliationLine[]
  readonly toleranceSeconds?: number
  /** Native readers classify all quantities, including an invoice with no lines. */
  readonly exact?: boolean
}): InvoiceHoursReconciliation => {
  const toleranceSeconds =
    input.toleranceSeconds ?? defaultReconciliationToleranceSeconds
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0)
    throw new RangeError('Use a non-negative whole-second tolerance.')
  const safe = (value: number): number => {
    if (!Number.isSafeInteger(value))
      throw new RangeError('Hours exceed the exact supported range.')
    return value
  }
  for (const entry of input.entries) safe(entry.seconds)
  for (const line of input.lines) safe(Math.round(line.quantity * 3600))
  const exact =
    input.exact === true ||
    input.lines.some(
      (line) =>
        line.comparable !== undefined || line.timeEntryIds !== undefined,
    )
  if (exact) {
    const owners = new Map<number, number>()
    const duplicate = new Set<number>()
    for (const line of input.lines)
      for (const id of line.timeEntryIds ?? []) {
        if (owners.has(id)) {
          duplicate.add(id)
        } else owners.set(id, line.id)
      }
    const notCompared = input.lines.filter(
      (line) =>
        line.comparable === false ||
        !line.timeEntryIds ||
        line.timeEntryIds.some((id) => duplicate.has(id)),
    )
    const unknown = new Set(notCompared.map((line) => line.id))
    const compared = input.lines.filter((line) => !unknown.has(line.id))
    const linked = new Map(
      input.entries
        .filter((entry) => entry.id !== undefined)
        .map((entry) => [entry.id!, entry]),
    )
    const used = new Set<number>()
    const lines = compared.map((line) => {
      const entryIds = line.timeEntryIds!.filter((id) => linked.has(id))
      entryIds.forEach((id) => used.add(id))
      const linkedSeconds = entryIds.reduce(
        (sum, id) => safe(sum + linked.get(id)!.seconds),
        0,
      )
      return {
        lineId: line.id,
        projectId: line.projectId,
        entryIds,
        ...figuresFor(
          linkedSeconds,
          safe(Math.round(line.quantity * 3600)),
          toleranceSeconds,
        ),
      }
    })
    const notComparedEntryIds = input.entries
      .filter((entry) => entry.id === undefined || !used.has(entry.id))
      .flatMap((entry) => (entry.id === undefined ? [] : [entry.id]))
    const comparisonComplete = input.entries.every(
      (entry) => entry.id !== undefined && used.has(entry.id),
    )
    const linkedSeconds = input.entries.reduce(
      (sum, entry) => safe(sum + entry.seconds),
      0,
    )
    const billedSeconds = lines.reduce(
      (sum, line) => safe(sum + line.billedSeconds),
      0,
    )
    const projects = [
      ...new Set(
        input.entries
          .map((entry) => entry.projectId)
          .concat(
            compared.flatMap((line) =>
              line.projectId === null ? [] : [line.projectId],
            ),
          ),
      ),
    ]
      .sort((a, b) => a - b)
      .map((projectId) => {
        const ownEntries = input.entries.filter(
          (entry) => entry.projectId === projectId,
        )
        const ownLines = lines.filter((line) => line.projectId === projectId)
        const figures = figuresFor(
          ownEntries.reduce((sum, entry) => safe(sum + entry.seconds), 0),
          ownLines.reduce((sum, line) => safe(sum + line.billedSeconds), 0),
          safe(toleranceSeconds * Math.max(1, ownLines.length)),
        )
        const complete = ownEntries.every(
          (entry) => entry.id !== undefined && used.has(entry.id),
        )
        return {
          ...figures,
          toleranceSeconds: safe(
            toleranceSeconds * Math.max(1, ownLines.length),
          ),
          projectId,
          projectName:
            ownEntries[0]?.projectName ??
            input.lines.find((line) => line.projectId === projectId)
              ?.projectName ??
            null,
          status: complete ? figures.status : ('not_comparable' as const),
        }
      })
    const totals = figuresFor(
      linkedSeconds,
      billedSeconds,
      safe(toleranceSeconds * Math.max(1, lines.length)),
    )
    const hasMismatch =
      input.entries.length > 0 &&
      lines.some((line) => line.status !== 'matched')
    return {
      ...totals,
      status:
        input.entries.length === 0
          ? 'matched'
          : comparisonComplete
            ? totals.status
            : 'not_comparable',
      toleranceSeconds,
      totalToleranceSeconds: safe(toleranceSeconds * Math.max(1, lines.length)),
      projects,
      notCompared,
      lines,
      entries: input.entries,
      comparisonComplete,
      hasMismatch,
      notComparedEntryIds,
    }
  }
  const byProject = new Map<
    number,
    { name: string | null; linked: number; billed: number }
  >()
  const slot = (projectId: number, name: string | null) => {
    let found = byProject.get(projectId)
    if (found === undefined) {
      found = { name, linked: 0, billed: 0 }
      byProject.set(projectId, found)
    } else if (found.name === null) found.name = name
    return found
  }
  for (const entry of input.entries) {
    const group = slot(entry.projectId, entry.projectName)
    group.linked = safe(group.linked + entry.seconds)
  }
  const notCompared: ReconciliationLine[] = []
  for (const line of input.lines) {
    if (line.projectId === null) {
      notCompared.push(line)
      continue
    }
    const group = slot(line.projectId, line.projectName)
    group.billed = safe(group.billed + Math.round(line.quantity * 3600))
  }
  const projects = [...byProject.entries()]
    .sort(([left], [right]) => left - right)
    .map(([projectId, { name, linked, billed }]) => ({
      projectId,
      projectName: name,
      ...figuresFor(linked, billed, toleranceSeconds),
    }))
  const linkedTotal = projects.reduce(
    (sum, project) => safe(sum + project.linkedSeconds),
    0,
  )
  const billedTotal = projects.reduce(
    (sum, project) => safe(sum + project.billedSeconds),
    0,
  )
  return {
    ...figuresFor(linkedTotal, billedTotal, toleranceSeconds),
    toleranceSeconds,
    totalToleranceSeconds: toleranceSeconds,
    projects,
    notCompared,
    lines: [],
    entries: input.entries,
    comparisonComplete: true,
    hasMismatch:
      input.entries.length > 0 &&
      projects.some((project) => project.status !== 'matched'),
    notComparedEntryIds: [],
  }
}
