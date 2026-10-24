import type { TeamViewer } from '@ezacto/core'
import { sql, type SQL } from 'drizzle-orm'

/** Repeat the authenticated actor snapshot inside the mutation statement. */
export const planningWriteActorSql = (viewer: Readonly<TeamViewer>): SQL => sql`EXISTS (
  SELECT 1 FROM users planning_actor
  WHERE planning_actor.id = ${viewer.userId} AND planning_actor.is_active = 1
    AND planning_actor.profile = ${viewer.profile}
    AND json(planning_actor.manager_grants) = json(${JSON.stringify(viewer.managerGrants)})
    AND NOT EXISTS (SELECT 1 FROM account_closures closed WHERE closed.user_id = planning_actor.id)
)`
