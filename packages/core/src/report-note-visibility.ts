/** Client-report note filtering and non-blocking delivery warnings (#55). */

export interface ReportNoteEntry {
  readonly id: number
  readonly notes: string | null
  /** Null inherits the organization default. */
  readonly clientVisible: boolean | null
}

export type ReportAudience = 'internal' | 'client'
export type ReportNoteWarningKind = 'url' | 'mention' | 'ticket_reference' | 'teammate_name'

export interface ReportNoteWarning {
  readonly entryId: number
  readonly kind: ReportNoteWarningKind
  readonly match: string
}

export interface ReportNotePreview {
  /** Warnings inform the confirmation surface; they never refuse delivery. */
  readonly allowed: true
  readonly entries: readonly ReportNoteEntry[]
  readonly warnings: readonly ReportNoteWarning[]
}

export const reportNoteIsClientVisible = (
  entry: Pick<ReportNoteEntry, 'clientVisible'>,
  organizationDefault: boolean,
): boolean => entry.clientVisible ?? organizationDefault

export const reportNotesForAudience = <Entry extends ReportNoteEntry>(
  entries: readonly Entry[],
  audience: ReportAudience,
  organizationDefault: boolean,
): readonly Entry[] =>
  audience === 'internal'
    ? entries
    : entries.filter((entry) => reportNoteIsClientVisible(entry, organizationDefault))

const warningMatches = (
  notes: string,
  teammateNames: readonly string[],
): readonly { kind: ReportNoteWarningKind; match: string }[] => {
  const matches: { kind: ReportNoteWarningKind; match: string }[] = []
  const add = (kind: ReportNoteWarningKind, pattern: RegExp): void => {
    for (const match of notes.matchAll(pattern)) {
      const value = match[0]
      if (!matches.some((item) => item.kind === kind && item.match === value)) {
        matches.push({ kind, match: value })
      }
    }
  }
  add('url', /https?:\/\/[^\s<>()]+/giu)
  add('mention', /(^|\s)@[\p{L}\p{N}_.-]+/gu)
  add('ticket_reference', /\b(?:ticket|issue|bug|task)\s*#?\d+\b/giu)
  for (const name of teammateNames) {
    const trimmed = name.trim()
    if (trimmed === '') continue
    if (notes.toLocaleLowerCase('en-US').includes(trimmed.toLocaleLowerCase('en-US'))) {
      matches.push({ kind: 'teammate_name', match: trimmed })
    }
  }
  return matches
}

export const previewClientReportNotes = <Entry extends ReportNoteEntry>(
  entries: readonly Entry[],
  organizationDefault: boolean,
  teammateNames: readonly string[] = [],
): ReportNotePreview => {
  const visible = reportNotesForAudience(entries, 'client', organizationDefault)
  return {
    allowed: true,
    entries: visible,
    warnings: visible.flatMap((entry) =>
      entry.notes === null
        ? []
        : warningMatches(entry.notes, teammateNames).map((warning) => ({
            entryId: entry.id,
            ...warning,
          })),
    ),
  }
}
