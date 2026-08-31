import {
  assertTimeEntryNoteRequirement,
  resolveTimeEntryNoteRequirement,
  timeEntryNoteLength,
  type EffectiveTimeEntryNoteRequirement,
} from '@ezacto/core'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { organizations, projects, userAssignments, users } from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export const resolveStoredTimeEntryNoteRequirement = async (
  database: Database,
  userId: number,
  projectId: number,
): Promise<EffectiveTimeEntryNoteRequirement | null> => {
  const [row] = await database
    .select()
    .from(userAssignments)
    .innerJoin(users, eq(users.id, userAssignments.userId))
    .innerJoin(projects, eq(projects.id, userAssignments.projectId))
    .innerJoin(organizations, eq(organizations.id, 1))
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.projectId, projectId),
      ),
    )
    .limit(1)
  if (!row) {
    throw new Error('time entry note policy requires an existing user assignment')
  }
  return resolveTimeEntryNoteRequirement({
    organization: {
      required: row.organizations.timeEntryNotesRequired,
      minimumLength: row.organizations.timeEntryNotesMinimumLength,
    },
    projectMinimumLength: row.projects.timeEntryNotesMinimumLength,
    personMinimumLength: row.users.timeEntryNotesMinimumLength,
    pairMinimumLength: row.user_assignments.timeEntryNotesMinimumLength,
  })
}

export const assertStoredTimeEntryNoteRequirement = async (
  database: Database,
  userId: number,
  projectId: number,
  notes: string | null | undefined,
): Promise<EffectiveTimeEntryNoteRequirement | null> => {
  const requirement = await resolveStoredTimeEntryNoteRequirement(database, userId, projectId)
  assertTimeEntryNoteRequirement(notes, requirement)
  return requirement
}

/**
 * Re-checks all four policy scopes inside a write statement. The caller still
 * performs the typed preflight above; this predicate closes the policy-change
 * race without deriving note length differently inside SQLite/D1.
 */
export const currentTimeEntryNotePolicyAllows = (
  userId: number,
  projectId: number,
  notes: string | null | undefined,
): SQL => {
  const actualLength = timeEntryNoteLength(notes)
  return sql`
    NOT EXISTS (
      SELECT 1 FROM ${organizations}
      WHERE ${organizations.id} = 1
        AND ${organizations.timeEntryNotesRequired} = 1
        AND ${organizations.timeEntryNotesMinimumLength} > ${actualLength}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${projects}
      WHERE ${projects.id} = ${projectId}
        AND ${projects.timeEntryNotesMinimumLength} > ${actualLength}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${users}
      WHERE ${users.id} = ${userId}
        AND ${users.timeEntryNotesMinimumLength} > ${actualLength}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${userAssignments}
      WHERE ${userAssignments.userId} = ${userId}
        AND ${userAssignments.projectId} = ${projectId}
        AND ${userAssignments.timeEntryNotesMinimumLength} > ${actualLength}
    )
  `
}
