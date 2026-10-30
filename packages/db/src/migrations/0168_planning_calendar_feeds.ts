// Exact inputs of the native resource-calendar projection and its authorization
// predicates. Actual time is deliberately excluded: it never enters the feed.
export const calendarFeedSourceTables = [
  'organizations',
  'users',
  'projects',
  'user_assignments',
  'teammate_assignments',
  'allocations',
  'placeholders',
  'placeholder_allocations',
  'time_off',
  'organization_holidays',
  'account_closures',
] as const
const hash = (column: string, size = 64) =>
  `length(${column})=${size} AND ${column} NOT GLOB '*[^a-f0-9]*'`
export const planningCalendarFeedsMigration = [
  `CREATE TABLE planning_calendar_source(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)) STRICT`,
  `INSERT INTO planning_calendar_source VALUES(1,0)`,
  `CREATE TABLE planning_calendar_instance(singleton INTEGER PRIMARY KEY CHECK(singleton=1),nonce TEXT NOT NULL CHECK(${hash('nonce')})) STRICT`,
  `INSERT INTO planning_calendar_instance VALUES(1,lower(hex(randomblob(32))))`,
  `CREATE TABLE planning_calendar_feeds(
   id TEXT PRIMARY KEY CHECK(${hash('id', 32)}),owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   scope TEXT NOT NULL CHECK(scope IN ('self','project','team')),project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
   from_date TEXT NOT NULL CHECK(date(from_date,'+0 days')=from_date),through_date TEXT NOT NULL CHECK(date(through_date,'+0 days')=through_date),
   include_names INTEGER NOT NULL CHECK(include_names IN (0,1)),
   password_hash TEXT CHECK(password_hash IS NULL OR (${hash('password_hash')})),
   instance_nonce TEXT NOT NULL CHECK(${hash('instance_nonce')}),uid_namespace TEXT NOT NULL CHECK(${hash('uid_namespace')}),
   credential_generation INTEGER NOT NULL DEFAULT 1 CHECK(credential_generation BETWEEN 1 AND 9007199254740991),
   authority_facts TEXT NOT NULL CHECK(json_valid(authority_facts)),
   issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,
   state_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(state_json) AND json_type(state_json)='array' AND length(state_json)<=1000000),
   state_revision INTEGER NOT NULL DEFAULT 0 CHECK(state_revision BETWEEN 0 AND 9007199254740991),
   rate_window INTEGER NOT NULL DEFAULT 0,rate_count INTEGER NOT NULL DEFAULT 0 CHECK(rate_count BETWEEN 0 AND 60),
   CHECK((scope='project' AND project_id IS NOT NULL) OR(scope<>'project' AND project_id IS NULL)),
   CHECK(julianday(through_date)-julianday(from_date) BETWEEN 0 AND 364),
   CHECK(julianday(expires_at)>julianday(issued_at) AND julianday(expires_at)-julianday(issued_at)<=90),
   CHECK(revoked_at IS NOT NULL OR password_hash IS NOT NULL)
 ) STRICT`,
  `CREATE INDEX planning_calendar_owner ON planning_calendar_feeds(owner_user_id,id)`,
  ...calendarFeedSourceTables.flatMap((table) => {
    const columns: Record<string, string> = {
      organizations: 'timezone,week_start_day', users: 'first_name,last_name,is_active,profile,manager_grants,weekly_capacity',
      projects: 'name,is_active', user_assignments: 'user_id,project_id,is_active,is_project_manager',
      teammate_assignments: 'manager_id,user_id', allocations: 'user_id,project_id,start_date,end_date,planned_seconds_per_week',
      placeholders: 'name,is_active', placeholder_allocations: 'placeholder_id,project_id,start_date,end_date,planned_seconds_per_week,state',
      time_off: 'user_id,start_date,end_date,seconds_per_day', organization_holidays: 'holiday_date', account_closures: 'user_id',
    }
    return ['INSERT', `UPDATE OF ${columns[table]}`, 'DELETE'].map((verb) =>
      `CREATE TRIGGER planning_calendar_source_${table}_${verb.split(' ')[0]!.toLowerCase()} AFTER ${verb} ON ${table} BEGIN UPDATE planning_calendar_source SET revision=revision+1 WHERE singleton=1; END`)
  }),
  `CREATE TRIGGER planning_calendar_source_retain BEFORE DELETE ON planning_calendar_source BEGIN SELECT RAISE(ABORT,'planning_calendar_source_required'); END`,
  `CREATE TRIGGER planning_calendar_source_monotonic BEFORE UPDATE ON planning_calendar_source WHEN NEW.singleton<>OLD.singleton OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'planning_calendar_source_must_advance'); END`,
  `CREATE TRIGGER planning_calendar_instance_retain BEFORE DELETE ON planning_calendar_instance BEGIN SELECT RAISE(ABORT,'planning_calendar_instance_required'); END`,
  `CREATE TRIGGER planning_calendar_identity_immutable BEFORE UPDATE ON planning_calendar_feeds
  WHEN NEW.id<>OLD.id OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.scope<>OLD.scope OR NEW.project_id IS NOT OLD.project_id
    OR NEW.from_date<>OLD.from_date OR NEW.through_date<>OLD.through_date OR NEW.include_names<>OLD.include_names
    OR NEW.uid_namespace<>OLD.uid_namespace OR NEW.authority_facts<>OLD.authority_facts
  BEGIN SELECT RAISE(ABORT,'planning_calendar_identity_immutable'); END`,
  `CREATE TRIGGER planning_calendar_closure AFTER INSERT ON account_closures BEGIN DELETE FROM planning_calendar_feeds WHERE owner_user_id=NEW.user_id; END`,
  `CREATE TRIGGER planning_calendar_organization_erasure AFTER DELETE ON organizations BEGIN DELETE FROM planning_calendar_feeds; UPDATE planning_calendar_instance SET nonce=lower(hex(randomblob(32))) WHERE singleton=1; END`,
] as const
