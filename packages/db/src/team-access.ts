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

/**
 * The projects a member is entitled to know about: the ones they have been put
 * on. `user_assignments` is already the answer to "what work is this person's"
 * everywhere else -- `timeEntryOptions` joins it to decide what they may log
 * against, and the project-budget report joins it to decide whose budgets they
 * may read -- so the directory answers the same question from the same table
 * rather than inventing a second notion of belonging.
 *
 * Deliberately without `is_active = 1`, which is what the two neighbours above
 * do use. They are asking a present-tense question -- what may this person log
 * against today, whose budget may they read today -- while a directory read is
 * mostly the catalog their own timesheet and expense history resolve names
 * through. An assignment that ended does not un-tell them a project's name; it
 * would only blank the labels on rows they still see, which is a worse product
 * and not a smaller disclosure.
 */
const memberProjectAccessSql = (viewer: Readonly<TeamViewer>, projectId: SQL): SQL =>
  sql`EXISTS (
    SELECT 1 FROM user_assignments member_assignment
    WHERE member_assignment.project_id = ${projectId}
      AND member_assignment.user_id = ${viewer.userId}
  )`

/**
 * A client is a member's to see when they are on a project of that client. The
 * relation is only ever reached this way round: being assigned to one project
 * of a client does not open that client's other projects, because the project
 * predicate above is applied to those rows on their own.
 *
 * Parents and subsidiaries are not walked. A member reads this catalog to label
 * and filter their own work, and their work hangs off the project's own client;
 * pulling in a chain of holding companies would hand back part of the very
 * structure the firm-wide list is being withheld to protect.
 */
const memberClientAccessSql = (viewer: Readonly<TeamViewer>, clientId: SQL): SQL =>
  sql`EXISTS (
    SELECT 1 FROM projects member_project
    WHERE member_project.client_id = ${clientId}
      AND ${memberProjectAccessSql(viewer, sql.raw('member_project.id'))}
  )`

/**
 * A task is a member's to see when it is assigned to one of their projects.
 * Reached through `task_assignments` rather than through the tasks table alone,
 * because a task only becomes work when a project adopts it; the bare row is a
 * name the firm uses, and the full list of those names is the shape of what
 * every other team does.
 *
 * Leaving tasks firm-wide was the one entitlement issue 491 did not take, on the
 * stated ground that the week grid resolves every row's task name from this
 * catalog and so needs all of it. That does not hold. `shell/browser.ts` filters
 * `catalog.tasks` to the ids reachable through `timeEntryOptions` before it fills
 * either the row select or the entry datalist, and `timeEntryOptions` is itself a
 * join through `user_assignments` and `task_assignments` -- a strict subset of
 * what this predicate returns. Nor can a label fall back to `#id`: `time_entries`
 * holds a RESTRICTed foreign key into `task_assignments(id, project_id, task_id)`,
 * so a row a member can see pins the very assignment row this predicate reads.
 *
 * `is_active` is left out on both hops, matching the project predicate above and
 * for the same reason: an archived assignment must still label the member's own
 * past timesheet rows.
 */
const memberTaskAccessSql = (viewer: Readonly<TeamViewer>, taskId: SQL): SQL =>
  sql`EXISTS (
    SELECT 1 FROM task_assignments member_task
    WHERE member_task.task_id = ${taskId}
      AND ${memberProjectAccessSql(viewer, sql.raw('member_task.project_id'))}
  )`

export const teamGeneralResourceAccessSql = (
  kind: GeneralResourceKind,
  viewer: Readonly<TeamViewer> | undefined,
): SQL => {
  if (viewer === undefined) return sql`1`
  // A member holds the work they are on, not the firm's book of who it sells to
  // (#491). The refusal is here rather than at the route because their own
  // Expenses screen and week grid read these collections to render: the
  // catalog they need is a subset of what they are entitled to, so narrowing
  // the rows keeps those screens whole while the firm-wide list stops being
  // theirs to hold. A 403 at the route takes the screens down with it.
  if (viewer.profile === 'member') {
    if (kind === 'projects') return memberProjectAccessSql(viewer, column('projects', 'id'))
    if (kind === 'clients') return memberClientAccessSql(viewer, column('clients', 'id'))
    if (kind === 'contacts')
      return memberClientAccessSql(viewer, column('contacts', 'client_id'))
    // Task assignments name a project on every row. Left open they hand back
    // the project ids, task ids, active flags and budgeted hours of work the
    // three predicates above have just withheld, which reassembles the firm's
    // project roster one table over -- so the same entitlement applies here.
    if (kind === 'task-assignments')
      return memberProjectAccessSql(viewer, column('task_assignments', 'project_id'))
    if (kind === 'tasks') return memberTaskAccessSql(viewer, column('tasks', 'id'))
  }
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
