import { sql } from 'drizzle-orm'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createResourceCalendarRepository } from '../src/resource-calendar.js'
import { createCalendarFeedService } from '../src/calendar-feeds.js'
import type { CalendarFeedInput } from '@ezacto/core'
import ICAL from 'ical.js'

const stamp = '2026-10-05T12:00:00.000Z'
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((close) => close()))
})

const setup = async (runtime: 'SQLite' | 'D1') => {
  const sqlite = runtime === 'SQLite' ? new BetterSqlite3(':memory:') : null
  const miniflare = sqlite
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: ['DB'],
      })
  const d1 = miniflare ? await miniflare.getD1Database('DB') : null
  if (sqlite) migrateContainer(sqlite)
  else await migrateD1(d1!)
  disposals.push(async () => {
    sqlite?.close()
    await miniflare?.dispose()
  })
  const database = sqlite ? createContainerDatabase(sqlite) : createD1Database(d1!)
  const run = async (text: string, ...params: unknown[]) => {
    if (sqlite) sqlite.prepare(text).run(...params)
    else
      await d1!
        .prepare(text)
        .bind(...params)
        .run()
  }
  await run(
    `INSERT INTO organizations(name,timezone,week_start_day,modules,created_at,updated_at)
    VALUES('Owned calendar fixture','America/Los_Angeles','monday','{"expenses":true,"invoices":true,"approval":true}',?,?)`,
    stamp,
    stamp,
  )
  for (const [id, profile, capacity] of [
    [1, 'administrator', 126000],
    [2, 'project_manager', 126000],
    [3, 'member', 72000],
    [4, 'member', 0],
  ] as const)
    await run(
      `INSERT INTO users(id,first_name,last_name,profile,manager_grants,weekly_capacity,created_at,updated_at)
      VALUES(?,'Owned',?, ?,'[]',?,?,?)`,
      id,
      `Person ${id}`,
      profile,
      capacity,
      stamp,
      stamp,
    )
  await run(
    "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned client','USD',?,?)",
    stamp,
    stamp,
  )
  for (const [id, name] of [
    [1, 'Visible project'],
    [2, 'Secret project'],
    [3, 'Archived project'],
  ] as const)
    await run(
      "INSERT INTO projects(id,client_id,name,bill_by,created_at,updated_at) VALUES(?,1,?,'people',?,?)",
      id,
      name,
      stamp,
      stamp,
    )
  await run(
    "INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Owned task',?,?)",
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO user_assignments(id,user_id,project_id,is_project_manager,created_at,updated_at)
    VALUES(1,2,1,1,?,?),(2,3,1,0,?,?),(3,3,2,0,?,?),(4,3,3,0,?,?)`,
    ...Array(8).fill(stamp),
  )
  await run(
    `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at)
    VALUES(1,1,1,1,?,?),(2,2,1,1,?,?),(3,3,1,1,?,?)`,
    ...Array(6).fill(stamp),
  )
  for (const [project, hours] of [
    [1, 10],
    [2, 15],
    [3, 100],
  ] as const)
    await run(
      `INSERT INTO allocations(user_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
      VALUES(3,?,'2026-10-07','2026-10-09',?,?,?)`,
      project,
      hours * 3600,
      stamp,
      stamp,
    )
  await run(
    `INSERT INTO time_off(user_id,start_date,end_date,kind,seconds_per_day,created_at,updated_at)
    VALUES(3,'2026-10-05','2026-10-05','vacation',18000,?,?)`,
    stamp,
    stamp,
  )
  await run(
    "INSERT INTO organization_holidays(holiday_date,name,created_at,updated_at) VALUES('2026-10-05','Owned holiday',?,?)",
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO time_entries(user_id,project_id,task_id,user_assignment_id,task_assignment_id,
    spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at)
    VALUES(3,3,1,4,3,'2026-10-06',4442,4442,4500,1,?,?)`,
    stamp,
    stamp,
  )
  await run('UPDATE projects SET is_active=0 WHERE id=3')
  await run(
    "INSERT INTO placeholders(id,name,created_by_user_id,created_at,updated_at) VALUES(1,'Owned demand',1,?,?)",
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO placeholder_allocations(placeholder_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
    VALUES(1,1,'2026-10-08','2026-10-08',7200,?,?)`,
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO placeholder_allocations(placeholder_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
    VALUES(1,2,'2026-10-12','2026-10-12',7200,?,?)`,
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO allocations(user_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
    VALUES(4,1,'2026-10-08','2026-10-09',4442,?,?)`,
    stamp,
    stamp,
  )
  for (const id of [1, 2, 3, 4])
    await run(
      "INSERT INTO sessions(id,user_id,selector,secret_hash,profile_snapshot,manager_grants_snapshot,created_at,last_seen_at,idle_expires_at,absolute_expires_at,updated_at) SELECT ?,id,?,? ,profile,'[]',?,?,'2027-01-01T00:00:00.000Z','2027-01-02T00:00:00.000Z',? FROM users WHERE id=?",
      id,
      String(id).padStart(16, 'S'),
      'a'.repeat(64),
      stamp,
      stamp,
      stamp,
      id,
    )
  return { database, run, sqlite, repository: createResourceCalendarRepository(database) }
}

const input: CalendarFeedInput = {
  scope: 'self',
  project_id: null,
  from_date: '2026-10-07',
  through_date: '2026-10-09',
  include_names: false,
}
const member = { userId: 3, sessionId: 3 },
  manager = { userId: 2, sessionId: 2 }
const events = (text: string) => new ICAL.Component(ICAL.parse(text)).getAllSubcomponents('vevent')
for (const target of ['SQLite', 'D1'] as const)
  describe(`advisory subscriptions ${target}`, () => {
    it('publishes only own minimized advisory facts, keeps stable IDs and reconciles updates/cancellations', async () => {
      const f = await setup(target),
        service = createCalendarFeedService(f.database, { now: () => new Date(stamp) })
      const issued = await service.create(member, input)
      const first = await service.subscribe(issued.username, issued.password)
      const [stored] = await f.database.all<{password_hash:string;state_json:string}>(sql`SELECT password_hash,state_json FROM planning_calendar_feeds WHERE id=${issued.feed.id}`)
      expect(stored!.password_hash).not.toBe(issued.password)
      expect(JSON.stringify(stored)).not.toContain('Owned Person')
      expect(JSON.stringify(stored)).not.toContain(issued.password)

      expect(first).not.toContain('Secret project')
      expect(first).not.toContain('Owned Person')
      expect(first).not.toContain('vacation')
      expect(events(first).some((e) => e.getFirstPropertyValue('summary') === '25h planned')).toBe(
        true,
      )
      expect(await service.download(member, issued.feed.id)).toBe(first)
      await f.run('UPDATE user_assignments SET is_active=0 WHERE user_id=3 AND project_id=2')
    await expect(service.subscribe(issued.username,issued.password)).resolves.toBe(first)
    const rotated = await service.rotate(member, issued.feed.id)
      await expect(service.subscribe(issued.username, issued.password)).rejects.toMatchObject({
        code: 'not_found',
      })
      expect(await service.subscribe(rotated.username, rotated.password)).toBe(first)
      await f.run('DELETE FROM allocations WHERE user_id=3')
      const changed = events(await service.subscribe(rotated.username, rotated.password))
      expect(changed.some((e) => e.getFirstPropertyValue('status') === 'CANCELLED')).toBe(true)
      expect(
        changed
          .filter((e) => e.getFirstPropertyValue('status') === 'CANCELLED')
          .every((e) => Number(e.getFirstPropertyValue('sequence')) === 1),
      ).toBe(true)
      await service.revoke(member, issued.feed.id)
      await expect(service.subscribe(rotated.username, rotated.password)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
    it('requires explicit current management scope and rejects lost access/foreign ownership', async () => {
      const f = await setup(target),
        service = createCalendarFeedService(f.database, { now: () => new Date(stamp) })
      await expect(service.create(member, { ...input, scope: 'team' })).rejects.toMatchObject({
        code: 'forbidden',
      })
      await expect(
        service.create(manager, { ...input, scope: 'project', project_id: 2 }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      const issued = await service.create(manager, {
        ...input,
        scope: 'project',
        project_id: 1,
        include_names: true,
      })
      expect(await service.subscribe(issued.username, issued.password)).toContain('Owned Person')
      await expect(service.download(member, issued.feed.id)).rejects.toMatchObject({
        code: 'not_found',
      })
      await f.run('UPDATE user_assignments SET is_project_manager=0 WHERE user_id=2')
      await expect(service.subscribe(issued.username, issued.password)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
    it('invalidates expiry, restoration, closed owners and revoked sessions without returning cached content', async () => {
      const f = await setup(target)
      let clock = new Date(stamp)
      const service = createCalendarFeedService(f.database, { now: () => clock }),
        issued = await service.create(member, { ...input, expires_at: '2026-10-06T00:00:00.000Z' })
      clock = new Date('2026-10-07T00:00:00.000Z')
      await expect(service.subscribe(issued.username, issued.password)).rejects.toMatchObject({
        code: 'not_found',
      })
      clock = new Date(stamp)
      await f.run(
        'UPDATE planning_calendar_instance SET nonce=lower(hex(randomblob(32))) WHERE singleton=1',
      )
      await expect(service.subscribe(issued.username, issued.password)).rejects.toMatchObject({
        code: 'not_found',
      })
      const fresh = await service.rotate(member, issued.feed.id)
      await f.run(
        "UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked',updated_at=? WHERE id=3",
        stamp,
        stamp,
      )
      await expect(service.download(member, issued.feed.id)).rejects.toMatchObject({
        code: 'forbidden',
      })
      await f.run('UPDATE users SET is_active=0 WHERE id=3')
      await expect(service.subscribe(fresh.username, fresh.password)).rejects.toMatchObject({
        code: 'forbidden',
      })
    })
    it('removes subscription credentials in the account closure transaction', async()=>{
    const f=await setup(target),service=createCalendarFeedService(f.database,{now:()=>new Date(stamp)})
    const issued=await service.create(member,input)
    await f.run("INSERT INTO account_deletion_requests(id,user_id,requested_at,notification_updated_at,updated_at) VALUES('close-member',3,?,?,?)",stamp,stamp,stamp)
    await f.run("INSERT INTO account_retention_policies(version,policy_json,published_by_user_id,published_at) VALUES(1,?,1,?)",JSON.stringify({acknowledged:true,frameworks:[],retained_records:[],response_target_days:14,operator_contact:'privacy@example.test',user_notice:'Fixture closure',backup_handling:'Replay closure before access.'}),stamp)
    await f.run("INSERT INTO account_closures(request_id,user_id,actor_user_id,closed_at,policy_version,policy_snapshot,inventory_json,replay_keys,retained_identity,apple_cleanup) SELECT 'close-member',3,1,?,version,policy_json,'[]','[]',1,'not_linked' FROM account_retention_policies ORDER BY version DESC LIMIT 1",stamp)
    expect(await f.database.all(sql`SELECT id FROM planning_calendar_feeds WHERE id=${issued.feed.id}`)).toEqual([])
    await expect(service.subscribe(issued.username,issued.password)).rejects.toMatchObject({code:'not_found'})
  })
    it('rechecks a changing source and serializes concurrent reload state without changing stable UIDs', async()=>{
      const f=await setup(target),service=createCalendarFeedService(f.database,{now:()=>new Date(stamp)})
      const issued=await service.create(member,input),before=events(await service.subscribe(issued.username,issued.password))
      let changed=false
      const racing=createCalendarFeedService(f.database,{now:()=>new Date(stamp),afterProjection:async()=>{if(!changed){changed=true;await f.run('DELETE FROM allocations WHERE user_id=3')}}})
      const after=events(await racing.subscribe(issued.username,issued.password))
      expect(after.some(e=>e.getFirstPropertyValue('status')==='CANCELLED')).toBe(true)
      expect(after.map(e=>e.getFirstPropertyValue('uid'))).toEqual(before.map(e=>e.getFirstPropertyValue('uid')))
      const simultaneous=await Promise.all([service.subscribe(issued.username,issued.password),service.subscribe(issued.username,issued.password)])
      expect(simultaneous[0]).toBe(simultaneous[1])
    })
    it('keeps older active subscriptions manageable when newer revoked records fill a page',async()=>{
      const f=await setup(target),service=createCalendarFeedService(f.database,{now:()=>new Date(stamp)}),issued=await service.create(member,input)
      await f.run("WITH RECURSIVE count(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM count WHERE n<20) INSERT INTO planning_calendar_feeds(id,owner_user_id,scope,project_id,from_date,through_date,include_names,password_hash,instance_nonce,uid_namespace,authority_facts,issued_at,expires_at,revoked_at) SELECT lower(hex(randomblob(16))),owner_user_id,scope,project_id,from_date,through_date,include_names,NULL,instance_nonce,uid_namespace,authority_facts,'2026-10-06T00:00:00.000Z',expires_at,'2026-10-06T01:00:00.000Z' FROM planning_calendar_feeds CROSS JOIN count WHERE id=?",issued.feed.id)
      const listed=await service.list(member)
      expect(listed).toHaveLength(20);expect(listed[0]!.id).toBe(issued.feed.id)
      await service.revoke(member,issued.feed.id)
      await expect(service.subscribe(issued.username,issued.password)).rejects.toMatchObject({code:'not_found'})
    })
    it('fences source changes during read and bounds credential/range abuse', async () => {
      const f = await setup(target),
        service = createCalendarFeedService(f.database, { now: () => new Date(stamp) }),
        issued = await service.create(member, input)
      let changed = false
      const racing = createCalendarFeedService(f.database, {
        now: () => new Date(stamp),
        afterProjection: async () => {
          if (!changed) {
            changed = true
            await service.revoke(member, issued.feed.id)
          }
        },
      })
      await expect(racing.subscribe(issued.username, issued.password)).rejects.toMatchObject({
        code: 'not_found',
      })
      await expect(
        service.create(member, { ...input, through_date: '2028-01-01' }),
      ).rejects.toMatchObject({ code: 'invalid' })
      const next = await service.create(member, input)
      for (let i = 0; i < 60; i++) await service.subscribe(next.username, next.password)
      await expect(service.subscribe(next.username, next.password)).rejects.toMatchObject({
        code: 'rate_limited',
      })
    })
  })
