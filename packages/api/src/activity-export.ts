import type { ActivityLogResource } from './outbox.js'

/**
 * The activity log as a CSV (issue 8): the filtered view, as a file.
 *
 * What it leaves out on purpose. The event payload is not a column: it is the
 * event as recorded, it can carry whatever the writer put in it, and a file is
 * the thing that leaves the building. The columns are the ones the screen
 * shows, plus the ids that let a reader find the record again.
 *
 * UTF-8 with a byte-order mark, because Excel reads a BOM-less file as the
 * system code page; CRLF and RFC 4180 quoting, because that is what every
 * importer agrees on.
 */

/** The most rows one export holds. Beyond it the file says so rather than stopping quietly. */
export const ACTIVITY_EXPORT_ROW_LIMIT = 5000

export const ACTIVITY_EXPORT_COLUMNS = [
  'Event id',
  'Event',
  'Occurred at',
  'Recorded at',
  'Subject type',
  'Subject id',
  'Actor type',
  'Actor id',
  'Actor name',
] as const

/**
 * A text cell. One beginning `=`, `+`, `-`, `@`, a tab or a carriage return is
 * run as a formula by a spreadsheet, and an actor's name is typed by a person,
 * so it is prefixed with a single quote and stays text.
 */
export const activityCsvText = (value: string): string => {
  const guarded = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value
  return /[",\r\n]/u.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

const row = (record: ActivityLogResource): string =>
  [
    activityCsvText(record.id),
    activityCsvText(record.eventType),
    activityCsvText(record.occurredAt),
    activityCsvText(record.recordedAt),
    activityCsvText(record.aggregateType),
    // Ids are numbers this code produced, never text a person typed, and a
    // guard would turn a plain figure into a string.
    String(record.aggregateId),
    activityCsvText(record.actor?.type ?? ''),
    record.actor?.id === null || record.actor === null ? '' : String(record.actor.id),
    activityCsvText(record.actor?.name ?? ''),
  ].join(',')

export const renderActivityCsv = (
  records: readonly ActivityLogResource[],
  truncated: boolean,
): string => {
  const lines = [ACTIVITY_EXPORT_COLUMNS.map(activityCsvText).join(','), ...records.map(row)]
  if (truncated) {
    lines.push(
      activityCsvText(
        `# Truncated: this file holds the newest ${ACTIVITY_EXPORT_ROW_LIMIT} matching entries. Narrow the period or the filters to export the rest.`,
      ),
    )
  }
  return `${'﻿'}${lines.join('\r\n')}\r\n`
}
