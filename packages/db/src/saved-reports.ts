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
export type SavedReportProfile =
  | 'member'
  | 'project_manager'
  | 'people_admin'
  | 'accounting'
  | 'executive_manager'
  | 'administrator'

export interface SavedReportSharing {
  readonly users: readonly { readonly userId: number; readonly name: string }[]
  readonly profiles: readonly SavedReportProfile[]
}

/**
 * A saved report that is a report's address rather than a builder definition:
 * the Reports kind and its query string (filters, grouping, sort, range).
 * Opening one navigates to the address, so the kind's own API runs it under the
 * viewer's current permissions.
 */
export interface SavedReportAddress {
  readonly report: string
  readonly query: string
}

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
  /** Set for a saved view of a report; null for a builder definition. */
  readonly view: SavedReportAddress | null
  readonly presentation: SavedReportPresentation
  readonly pinned: boolean
  /** Shared with the viewer by name or by their role; never true for the owner. */
  readonly shared: boolean
  /** Who the owner shared it with. Empty for anyone who cannot change the shares. */
  readonly sharing: SavedReportSharing
  readonly ownedByViewer: boolean
  /** The owner, or an administrator. */
  readonly canDelete: boolean
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
  viewerIsAdmin: number
  sharedUsersJson: string
  sharedProfilesJson: string
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

const kindPattern = /^[a-z][a-z0-9-]{0,39}$/u

/**
 * The address as stored: the kind apart from its query, and a query that never
 * carries the pointer back to the saved report it was opened from.
 */
export const savedReportAddress = (value: unknown): SavedReportAddress => {
  if (value === null || typeof value !== 'object') throw new TypeError('view must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.report !== 'string' || !kindPattern.test(record.report)) {
    throw new RangeError('view report must be a report kind')
  }
  if (typeof record.query !== 'string' || record.query.length > 2000) {
    throw new RangeError('view query must be a string of at most 2000 characters')
  }
  const params = new URLSearchParams(record.query.replace(/^\?/u, ''))
  params.delete('report')
  params.delete('saved')
  return { report: record.report, query: params.toString() }
}

const addressOf = (definitionJson: string): SavedReportAddress | null => {
  const stored = (JSON.parse(definitionJson) as { view?: unknown }).view
  return stored === undefined ? null : savedReportAddress(stored)
}

const mapped = (row: Row, viewerUserId: number): SavedReportRecord => {
  const ownedByViewer = row.ownerUserId === viewerUserId
  return {
  definition: deserializeReportDefinition(JSON.parse(row.definitionJson)),
  ownerUserId: row.ownerUserId,
  ownerName: row.ownerName,
  isCustom: row.isCustom === 1,
  view: addressOf(row.definitionJson),
  presentation: presentation(JSON.parse(row.presentationJson)),
  pinned: row.pinned === 1,
  shared: row.shared === 1,
  sharing: ownedByViewer
    ? {
        users: JSON.parse(row.sharedUsersJson) as SavedReportSharing['users'],
        profiles: JSON.parse(row.sharedProfilesJson) as SavedReportSharing['profiles'],
      }
    : { users: [], profiles: [] },
  ownedByViewer,
  canDelete: ownedByViewer || row.viewerIsAdmin === 1,
  }
}

// The one rule for who may see a saved report: its owner, anyone it was shared
// with by name, anyone whose profile it was shared with, and administrators.
// Every read, run, pin and duplicate goes through it, so the web screen and the
// API cannot disagree about what a private report is.
const viewerIsAdministrator = (viewerUserId: number) => sql`EXISTS(SELECT 1 FROM users viewer
  WHERE viewer.id = ${viewerUserId} AND viewer.profile = 'administrator')`

const sharedWith = (viewerUserId: number) => sql`(EXISTS(SELECT 1 FROM saved_report_shares share
    WHERE share.report_id = report.id AND share.user_id = ${viewerUserId})
  OR EXISTS(SELECT 1 FROM saved_report_role_shares role_share
    JOIN users viewer ON viewer.id = ${viewerUserId} AND viewer.profile = role_share.profile
    WHERE role_share.report_id = report.id))`

const visibleTo = (viewerUserId: number) => sql`(report.owner_user_id = ${viewerUserId}
  OR ${sharedWith(viewerUserId)} OR ${viewerIsAdministrator(viewerUserId)})`

const select = (viewerUserId: number) => sql`
  SELECT report.definition_json AS "definitionJson", report.owner_user_id AS "ownerUserId",
    owner.first_name || ' ' || owner.last_name AS "ownerName", report.is_custom AS "isCustom",
    report.presentation_json AS "presentationJson", report.version,
    EXISTS(SELECT 1 FROM saved_report_pins pin
      WHERE pin.report_id = report.id AND pin.user_id = ${viewerUserId}) AS pinned,
    (report.owner_user_id <> ${viewerUserId} AND ${sharedWith(viewerUserId)}) AS shared,
    ${viewerIsAdministrator(viewerUserId)} AS "viewerIsAdmin",
    COALESCE((SELECT json_group_array(json_object('userId', share.user_id,
        'name', member.first_name || ' ' || member.last_name))
      FROM saved_report_shares share JOIN users member ON member.id = share.user_id
      WHERE share.report_id = report.id), '[]') AS "sharedUsersJson",
    COALESCE((SELECT json_group_array(role_share.profile) FROM saved_report_role_shares role_share
      WHERE role_share.report_id = report.id), '[]') AS "sharedProfilesJson"
  FROM saved_reports report JOIN users owner ON owner.id = report.owner_user_id`

export const createSavedReportStore = (database: Database) => ({
  create: async (input: Readonly<{
    definition: ReportDefinition
    ownerUserId: number
    isCustom?: boolean
    view?: SavedReportAddress
    presentation: SavedReportPresentation
  }>): Promise<SavedReportRecord> => {
    const definition = serializeReportDefinition(input.definition)
    const address = input.view === undefined ? undefined : savedReportAddress(input.view)
    const view = presentation(input.presentation)
    await database.run(sql`
      INSERT INTO saved_reports
        (id, owner_user_id, definition_json, version, is_custom, presentation_json, created_at, updated_at)
      VALUES (${definition.id}, ${input.ownerUserId},
        ${JSON.stringify(address === undefined ? definition : { ...definition, view: address })},
        ${definition.version}, ${input.isCustom === false || address !== undefined ? 0 : 1}, ${JSON.stringify(view)},
        ${definition.createdAt}, ${definition.updatedAt})`)
    const created = await database.all<Row>(sql`${select(input.ownerUserId)} WHERE report.id = ${definition.id}`)
    return mapped(created[0]!, input.ownerUserId)
  },

  list: async (input: Readonly<{
    viewerUserId: number
    view?: SavedReportView
    query?: string
    customOnly?: boolean
  }>): Promise<readonly SavedReportRecord[]> => {
    const rows = await database.all<Row>(sql`${select(input.viewerUserId)}
      WHERE ${visibleTo(input.viewerUserId)}
      ORDER BY pinned DESC, report.updated_at DESC, report.id`)
    const q = input.query?.trim().toLocaleLowerCase('en-US') ?? ''
    return rows.map((row) => mapped(row, input.viewerUserId)).filter((report) =>
      (input.view !== 'yours' || report.ownerUserId === input.viewerUserId) &&
      (input.view !== 'shared' || report.shared) &&
      (input.customOnly !== true || report.isCustom) &&
      (q === '' || report.definition.name.toLocaleLowerCase('en-US').includes(q)),
    )
  },

  read: async (reportId: string, viewerUserId: number): Promise<SavedReportRecord | null> => {
    const rows = await database.all<Row>(sql`${select(viewerUserId)}
      WHERE report.id = ${reportId} AND ${visibleTo(viewerUserId)}`)
    return rows[0] === undefined ? null : mapped(rows[0], viewerUserId)
  },

  update: async (input: Readonly<{
    reportId: string
    ownerUserId: number
    expectedVersion: number
    changes: UpdateReportDefinitionInput
    view?: SavedReportAddress
    presentation?: SavedReportPresentation
  }>): Promise<'not_found' | 'version_conflict' | SavedReportRecord> => {
    const owned = await database.all<Row>(sql`${select(input.ownerUserId)}
      WHERE report.id = ${input.reportId} AND report.owner_user_id = ${input.ownerUserId}`)
    const current = owned[0]
    if (current === undefined) return 'not_found'
    if (current.version !== input.expectedVersion) return 'version_conflict'
    const existing = deserializeReportDefinition(JSON.parse(current.definitionJson))
    const currentView = addressOf(current.definitionJson)
    const { name, updatedAt, ...content } = input.changes
    if (currentView === null && input.view !== undefined) {
      throw new TypeError('only a saved view has an address to change')
    }
    if (currentView !== null && Object.values(content).some((part) => part !== undefined)) {
      throw new TypeError('a saved view keeps its report in its address, not in fields or metrics')
    }
    // A view's name and address are all there is to change, and saving it again
    // at the same address is still a save: the version moves so a second
    // editor's stale copy is refused.
    const next = currentView === null
      ? updateReportDefinition(existing, input.changes)
      : { ...existing, name: name ?? existing.name, version: existing.version + 1, updatedAt }
    const nextView = input.view === undefined ? currentView : savedReportAddress(input.view)
    const nextPresentation = input.presentation === undefined
      ? presentation(JSON.parse(current.presentationJson))
      : presentation(input.presentation)
    const changed = await database.all<{ id: string }>(sql`
      UPDATE saved_reports SET definition_json = ${JSON.stringify(
        nextView === null ? serializeReportDefinition(next) : { ...serializeReportDefinition(next), view: nextView })},
        version = ${next.version}, presentation_json = ${JSON.stringify(nextPresentation)},
        updated_at = ${next.updatedAt}
      WHERE id = ${input.reportId} AND owner_user_id = ${input.ownerUserId}
        AND version = ${input.expectedVersion}
      RETURNING id`)
    if (changed.length === 0) return 'version_conflict'
    return (await database.all<Row>(sql`${select(input.ownerUserId)} WHERE report.id = ${input.reportId}`)).map((row) => mapped(row, input.ownerUserId))[0]!
  },

  setShared: async (reportId: string, ownerUserId: number, userId: number, shared: boolean, at: string): Promise<boolean> => {
    const owned = await database.all<{ id: string }>(sql`SELECT id FROM saved_reports WHERE id = ${reportId} AND owner_user_id = ${ownerUserId}`)
    if (owned.length === 0 || userId === ownerUserId) return false
    if (shared) await database.run(sql`INSERT INTO saved_report_shares (report_id, user_id, created_at)
      VALUES (${reportId}, ${userId}, ${at}) ON CONFLICT (report_id, user_id) DO NOTHING`)
    else await database.run(sql`DELETE FROM saved_report_shares WHERE report_id = ${reportId} AND user_id = ${userId}`)
    return true
  },

  setSharedWithProfile: async (reportId: string, ownerUserId: number, profile: SavedReportProfile, shared: boolean, at: string): Promise<boolean> => {
    const owned = await database.all<{ id: string }>(sql`SELECT id FROM saved_reports WHERE id = ${reportId} AND owner_user_id = ${ownerUserId}`)
    if (owned.length === 0) return false
    if (shared) await database.run(sql`INSERT INTO saved_report_role_shares (report_id, profile, created_at)
      VALUES (${reportId}, ${profile}, ${at}) ON CONFLICT (report_id, profile) DO NOTHING`)
    else await database.run(sql`DELETE FROM saved_report_role_shares WHERE report_id = ${reportId} AND profile = ${profile}`)
    return true
  },

  setPinned: async (reportId: string, viewerUserId: number, pinned: boolean, at: string): Promise<boolean> => {
    const entitled = await database.all<{ id: string }>(sql`SELECT report.id FROM saved_reports report
      WHERE report.id = ${reportId} AND ${visibleTo(viewerUserId)}`)
    if (entitled.length === 0) return false
    if (pinned) await database.run(sql`INSERT INTO saved_report_pins (report_id, user_id, created_at)
      VALUES (${reportId}, ${viewerUserId}, ${at}) ON CONFLICT (report_id, user_id) DO NOTHING`)
    else await database.run(sql`DELETE FROM saved_report_pins WHERE report_id = ${reportId} AND user_id = ${viewerUserId}`)
    return true
  },

  /** The owner or an administrator may delete; sharing grants no such right. */
  delete: async (reportId: string, actorUserId: number): Promise<boolean> =>
    (await database.all<{ id: string }>(sql`DELETE FROM saved_reports
      WHERE id = ${reportId}
        AND (owner_user_id = ${actorUserId} OR ${viewerIsAdministrator(actorUserId)}) RETURNING id`)).length > 0,
})
