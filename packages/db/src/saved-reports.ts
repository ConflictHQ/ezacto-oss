/** Persistence and entitlement boundary for saved report definitions (#715). */
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  deserializeReportDefinition,
  serializeReportDefinition,
  updateReportDefinition,
  type ReportDefinition,
  type UpdateReportDefinitionInput,
} from './report-definitions.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
export type SavedReportView = 'all' | 'yours' | 'shared'

export interface SavedReportPresentation {
  readonly result: 'summary' | 'detailed'
  readonly grouped: boolean
  readonly includeZeroValues: boolean
}

export interface SavedReportRecord {
  readonly definition: ReportDefinition
  readonly ownerUserId: number
  readonly ownerName: string
  readonly isCustom: boolean
  readonly presentation: SavedReportPresentation
  readonly pinned: boolean
  readonly shared: boolean
}

interface Row {
  definitionJson: string
  ownerUserId: number
  ownerName: string
  isCustom: number
  presentationJson: string
  pinned: number
  shared: number
  version: number
}

const presentation = (value: unknown): SavedReportPresentation => {
  if (value === null || typeof value !== 'object') throw new TypeError('report presentation must be an object')
  const record = value as Record<string, unknown>
  if (record.result !== 'summary' && record.result !== 'detailed') {
    throw new RangeError('report presentation result is invalid')
  }
  if (typeof record.grouped !== 'boolean' || typeof record.includeZeroValues !== 'boolean') {
    throw new TypeError('report presentation choices must be boolean')
  }
  return {
    result: record.result,
    grouped: record.grouped,
    includeZeroValues: record.includeZeroValues,
  }
}

const mapped = (row: Row): SavedReportRecord => ({
  definition: deserializeReportDefinition(JSON.parse(row.definitionJson)),
  ownerUserId: row.ownerUserId,
  ownerName: row.ownerName,
  isCustom: row.isCustom === 1,
  presentation: presentation(JSON.parse(row.presentationJson)),
  pinned: row.pinned === 1,
  shared: row.shared === 1,
})

const select = (viewerUserId: number) => sql`
  SELECT report.definition_json AS "definitionJson", report.owner_user_id AS "ownerUserId",
    owner.first_name || ' ' || owner.last_name AS "ownerName", report.is_custom AS "isCustom",
    report.presentation_json AS "presentationJson", report.version,
    EXISTS(SELECT 1 FROM saved_report_pins pin
      WHERE pin.report_id = report.id AND pin.user_id = ${viewerUserId}) AS pinned,
    EXISTS(SELECT 1 FROM saved_report_shares share
      WHERE share.report_id = report.id AND share.user_id = ${viewerUserId}) AS shared
  FROM saved_reports report JOIN users owner ON owner.id = report.owner_user_id`

export const createSavedReportStore = (database: Database) => ({
  create: async (input: Readonly<{
    definition: ReportDefinition
    ownerUserId: number
    isCustom?: boolean
    presentation: SavedReportPresentation
  }>): Promise<SavedReportRecord> => {
    const definition = serializeReportDefinition(input.definition)
    const view = presentation(input.presentation)
    await database.run(sql`
      INSERT INTO saved_reports
        (id, owner_user_id, definition_json, version, is_custom, presentation_json, created_at, updated_at)
      VALUES (${definition.id}, ${input.ownerUserId}, ${JSON.stringify(definition)},
        ${definition.version}, ${input.isCustom === false ? 0 : 1}, ${JSON.stringify(view)},
        ${definition.createdAt}, ${definition.updatedAt})`)
    const created = await database.all<Row>(sql`${select(input.ownerUserId)} WHERE report.id = ${definition.id}`)
    return mapped(created[0]!)
  },

  list: async (input: Readonly<{
    viewerUserId: number
    view?: SavedReportView
    query?: string
    customOnly?: boolean
  }>): Promise<readonly SavedReportRecord[]> => {
    const rows = await database.all<Row>(sql`${select(input.viewerUserId)}
      WHERE (report.owner_user_id = ${input.viewerUserId}
        OR EXISTS(SELECT 1 FROM saved_report_shares entitled
          WHERE entitled.report_id = report.id AND entitled.user_id = ${input.viewerUserId}))
      ORDER BY pinned DESC, report.updated_at DESC, report.id`)
    const q = input.query?.trim().toLocaleLowerCase('en-US') ?? ''
    return rows.map(mapped).filter((report) =>
      (input.view !== 'yours' || report.ownerUserId === input.viewerUserId) &&
      (input.view !== 'shared' || report.shared) &&
      (input.customOnly !== true || report.isCustom) &&
      (q === '' || report.definition.name.toLocaleLowerCase('en-US').includes(q)),
    )
  },

  read: async (reportId: string, viewerUserId: number): Promise<SavedReportRecord | null> => {
    const rows = await database.all<Row>(sql`${select(viewerUserId)}
      WHERE report.id = ${reportId}
        AND (report.owner_user_id = ${viewerUserId}
          OR EXISTS(SELECT 1 FROM saved_report_shares entitled
            WHERE entitled.report_id = report.id AND entitled.user_id = ${viewerUserId}))`)
    return rows[0] === undefined ? null : mapped(rows[0])
  },

  update: async (input: Readonly<{
    reportId: string
    ownerUserId: number
    expectedVersion: number
    changes: UpdateReportDefinitionInput
    presentation?: SavedReportPresentation
  }>): Promise<'not_found' | 'version_conflict' | SavedReportRecord> => {
    const owned = await database.all<Row>(sql`${select(input.ownerUserId)}
      WHERE report.id = ${input.reportId} AND report.owner_user_id = ${input.ownerUserId}`)
    const current = owned[0]
    if (current === undefined) return 'not_found'
    if (current.version !== input.expectedVersion) return 'version_conflict'
    const next = updateReportDefinition(deserializeReportDefinition(JSON.parse(current.definitionJson)), input.changes)
    const nextPresentation = input.presentation === undefined
      ? presentation(JSON.parse(current.presentationJson))
      : presentation(input.presentation)
    const changed = await database.all<{ id: string }>(sql`
      UPDATE saved_reports SET definition_json = ${JSON.stringify(serializeReportDefinition(next))},
        version = ${next.version}, presentation_json = ${JSON.stringify(nextPresentation)},
        updated_at = ${next.updatedAt}
      WHERE id = ${input.reportId} AND owner_user_id = ${input.ownerUserId}
        AND version = ${input.expectedVersion}
      RETURNING id`)
    if (changed.length === 0) return 'version_conflict'
    return (await database.all<Row>(sql`${select(input.ownerUserId)} WHERE report.id = ${input.reportId}`)).map(mapped)[0]!
  },

  setShared: async (reportId: string, ownerUserId: number, userId: number, shared: boolean, at: string): Promise<boolean> => {
    const owned = await database.all<{ id: string }>(sql`SELECT id FROM saved_reports WHERE id = ${reportId} AND owner_user_id = ${ownerUserId}`)
    if (owned.length === 0 || userId === ownerUserId) return false
    if (shared) await database.run(sql`INSERT INTO saved_report_shares (report_id, user_id, created_at)
      VALUES (${reportId}, ${userId}, ${at}) ON CONFLICT (report_id, user_id) DO NOTHING`)
    else await database.run(sql`DELETE FROM saved_report_shares WHERE report_id = ${reportId} AND user_id = ${userId}`)
    return true
  },

  setPinned: async (reportId: string, viewerUserId: number, pinned: boolean, at: string): Promise<boolean> => {
    const entitled = await database.all<{ id: string }>(sql`SELECT report.id FROM saved_reports report
      WHERE report.id = ${reportId} AND (report.owner_user_id = ${viewerUserId}
        OR EXISTS(SELECT 1 FROM saved_report_shares share WHERE share.report_id = report.id AND share.user_id = ${viewerUserId}))`)
    if (entitled.length === 0) return false
    if (pinned) await database.run(sql`INSERT INTO saved_report_pins (report_id, user_id, created_at)
      VALUES (${reportId}, ${viewerUserId}, ${at}) ON CONFLICT (report_id, user_id) DO NOTHING`)
    else await database.run(sql`DELETE FROM saved_report_pins WHERE report_id = ${reportId} AND user_id = ${viewerUserId}`)
    return true
  },

  delete: async (reportId: string, ownerUserId: number): Promise<boolean> =>
    (await database.all<{ id: string }>(sql`DELETE FROM saved_reports
      WHERE id = ${reportId} AND owner_user_id = ${ownerUserId} RETURNING id`)).length > 0,
})
