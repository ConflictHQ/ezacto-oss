import type { GeneralResourceKind, TeamViewer } from '@ezacto/core'
import { sql, type SQL } from 'drizzle-orm'

export interface TeamAccessPredicate {
  readonly sql: string
  readonly bindings: readonly unknown[]
}

const isManagedScope = (viewer: Readonly<TeamViewer>): boolean =>
  viewer.profile === 'project_manager'

export const teamPersonAccessPredicate = (
  viewer: Readonly<TeamViewer>,
  userAlias = 'user',
): TeamAccessPredicate =>
  isManagedScope(viewer)
    ? {
        sql: `(${userAlias}.id = ? OR EXISTS (
          SELECT 1 FROM teammate_assignments teammate
          WHERE teammate.manager_id = ? AND teammate.user_id = ${userAlias}.id
        ) OR EXISTS (
          SELECT 1
          FROM user_assignments managed_assignment
          JOIN user_assignments manager_assignment
            ON manager_assignment.project_id = managed_assignment.project_id
           AND manager_assignment.user_id = ?
           AND manager_assignment.is_active = 1
           AND manager_assignment.is_project_manager = 1
          WHERE managed_assignment.user_id = ${userAlias}.id
            AND managed_assignment.is_active = 1
        ))`,
        bindings: [viewer.userId, viewer.userId, viewer.userId],
      }
    : { sql: '1', bindings: [] }

export const teamProjectAccessPredicate = (
  viewer: Readonly<TeamViewer>,
  projectAlias = 'project',
): TeamAccessPredicate =>
  isManagedScope(viewer)
    ? {
        sql: `EXISTS (
          SELECT 1 FROM user_assignments manager_assignment
          WHERE manager_assignment.project_id = ${projectAlias}.id
            AND manager_assignment.user_id = ?
            AND manager_assignment.is_active = 1
            AND manager_assignment.is_project_manager = 1
        )`,
        bindings: [viewer.userId],
      }
    : { sql: '1', bindings: [] }

export const teamAssignmentAccessPredicate = (
  viewer: Readonly<TeamViewer>,
  userAlias = 'user',
  projectAlias = 'project',
): TeamAccessPredicate => {
  const person = teamPersonAccessPredicate(viewer, userAlias)
  const project = teamProjectAccessPredicate(viewer, projectAlias)
  return {
    sql: `(${person.sql}) AND (${project.sql})`,
    bindings: [...person.bindings, ...project.bindings],
  }
}

const column = (alias: string, name: string): SQL => sql.raw(`${alias}.${name}`)

export const teamPersonAccessSql = (
  viewer: Readonly<TeamViewer>,
  userAlias = 'users',
): SQL => {
  if (!isManagedScope(viewer)) return sql`1`
  const userId = column(userAlias, 'id')
  return sql`(${userId} = ${viewer.userId} OR EXISTS (
    SELECT 1 FROM teammate_assignments teammate
    WHERE teammate.manager_id = ${viewer.userId} AND teammate.user_id = ${userId}
  ) OR EXISTS (
    SELECT 1
    FROM user_assignments managed_assignment
    JOIN user_assignments manager_assignment
      ON manager_assignment.project_id = managed_assignment.project_id
     AND manager_assignment.user_id = ${viewer.userId}
     AND manager_assignment.is_active = 1
     AND manager_assignment.is_project_manager = 1
    WHERE managed_assignment.user_id = ${userId}
      AND managed_assignment.is_active = 1
  ))`
}

export const teamProjectAccessSql = (
  viewer: Readonly<TeamViewer>,
  projectAlias = 'projects',
): SQL => {
  if (!isManagedScope(viewer)) return sql`1`
  const projectId = column(projectAlias, 'id')
  return sql`EXISTS (
    SELECT 1 FROM user_assignments manager_assignment
    WHERE manager_assignment.project_id = ${projectId}
      AND manager_assignment.user_id = ${viewer.userId}
      AND manager_assignment.is_active = 1
      AND manager_assignment.is_project_manager = 1
  )`
}

export const teamGeneralResourceAccessSql = (
  kind: GeneralResourceKind,
  viewer: Readonly<TeamViewer> | undefined,
): SQL => {
  if (viewer === undefined) return sql`1`
  if (kind === 'users') return teamPersonAccessSql(viewer)
  if (kind !== 'user-assignments') return sql`1`
  const userId = column('user_assignments', 'user_id')
  const projectId = column('user_assignments', 'project_id')
  return sql`EXISTS (
      SELECT 1 FROM users scoped_user
      WHERE scoped_user.id = ${userId}
        AND ${teamPersonAccessSql(viewer, 'scoped_user')}
    ) AND EXISTS (
      SELECT 1 FROM projects scoped_project
      WHERE scoped_project.id = ${projectId}
        AND ${teamProjectAccessSql(viewer, 'scoped_project')}
    )`
}
