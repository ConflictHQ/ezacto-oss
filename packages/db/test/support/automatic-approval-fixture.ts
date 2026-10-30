/** Disposable native-runtime fixture; no provider calls or live credentials. */
export const seedAutomaticApprovalFixture = async (
  run: (statement: string, ...bindings: unknown[]) => Promise<void>,
  now: string,
): Promise<string> => {
  const created = new Date(Date.parse(now) - 5 * 86400000).toISOString()
  const submitted = new Date(Date.parse(now) - 2 * 86400000).toISOString()
  await run(
    `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Automatic Approval Fixture','{"approval":true}',?,?)`,
    created,
    created,
  )
  await run(
    `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Maya','Member','member','[]',?,?),(10,'Ada','Admin','administrator','[]',?,?)`,
    created,
    created,
    created,
    created,
  )
  await run(
    `INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(1,'maya@example.test',1,?,?,?)`,
    created,
    created,
    created,
  )
  await run(
    `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Fixture','USD',?,?)`,
    created,
    created,
  )
  await run(
    `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Work',?,?)`,
    created,
    created,
  )
  await run(
    `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Work',?,?)`,
    created,
    created,
  )
  await run(
    `INSERT INTO user_assignments(id,user_id,project_id,created_at,updated_at) VALUES(1,1,1,?,?)`,
    created,
    created,
  )
  await run(
    `INSERT INTO task_assignments(id,task_id,project_id,billable,created_at,updated_at) VALUES(1,1,1,1,?,?)`,
    created,
    created,
  )
  await run(
    `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(1,1,1,1,1,1,'2026-08-25',3600,3600,3600,1,?,?)`,
    created,
    created,
  )
  await run(
    `UPDATE organizations SET auto_approval_enabled=1,auto_approval_window_days=1,auto_approval_effective_from=?,auto_approval_actor_user_id=10 WHERE id=1`,
    created,
  )
  return submitted
}
