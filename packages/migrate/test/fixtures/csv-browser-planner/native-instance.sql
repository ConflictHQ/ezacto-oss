-- Invented, owned acceptance destination. Never an exported production database.
INSERT INTO organizations
 (id,name,currency,timezone,week_start_day,time_entry_mode,time_rounding_mode,time_rounding_minutes,modules,created_at,updated_at)
VALUES
 (1,'Owned planner acceptance','USD','UTC','monday','duration','nearest',6,'{"expenses":true,"approval":true}',
  '2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO users
 (id,first_name,last_name,profile,is_owner,is_active,manager_grants,has_access_to_all_future_projects,created_at,updated_at)
VALUES
 (1,'Fixture','Owner','administrator',0,1,'[]',1,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z'),
 (2,'Actual','Administrator','administrator',0,1,'[]',1,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z'),
 (3,'Fixture','Member','member',0,1,'[]',0,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO user_emails (user_id,address,verified_at,is_primary,created_at,updated_at)
VALUES
 (1,'owner@example.invalid','2026-09-08T12:00:00.000Z',1,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z'),
 (2,'administrator@example.invalid','2026-09-08T12:00:00.000Z',1,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z'),
 (3,'member@example.invalid','2026-09-08T12:00:00.000Z',1,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO clients (id,name,currency,created_at,updated_at)
VALUES (1,'Fixture studio','USD','2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z'),
 (2,'Other studio','EUR','2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO projects (id,client_id,name,created_at,updated_at)
VALUES (1,1,'Existing project','2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z'),
 (2,2,'Other project','2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO tasks (id,name,created_at,updated_at)
VALUES (1,'Existing task','2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO user_assignments (id,project_id,user_id,created_at,updated_at)
VALUES (1,1,3,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO task_assignments (id,project_id,task_id,billable,created_at,updated_at)
VALUES (1,1,1,1,'2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
INSERT INTO event_outbox
 (id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
VALUES ('planner-acceptance-untouched','fixture',1,1,'fixture.untouched','{"schema_version":1}',
 '2026-09-08T12:00:00.000Z','2026-09-08T12:00:00.000Z');
