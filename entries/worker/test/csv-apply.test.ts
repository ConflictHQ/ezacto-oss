import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { migrateD1, createD1SessionStore } from '@ezacto/db'
import { createWorkerCsvStaging } from '../src/csv-staging.js'
import { createWorkerCsvApply } from '../src/csv-apply.js'
import { sha256Hex } from '../../../packages/migrate/src/portable-hash.js'
const fixtures:Miniflare[]=[]
afterEach(async()=>{await Promise.all(fixtures.splice(0).map(f=>f.dispose()))})
const firstBytes=new TextEncoder().encode('Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\nowned@example.test,C,P,T,Owned private note,Yes,2026-09-01,09:00:00,2026-09-01,10:00:00,01:00:00\n')
const text=new TextDecoder().decode(firstBytes)
const bytes=new TextEncoder().encode(text+text.trimEnd().split('\n')[1]!.replaceAll('2026-09-01','2026-09-02')+'\n')
const chunks=async function*(){yield bytes}
const fixture=async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['PRIVATE']});fixtures.push(mf)
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('PRIVATE');await migrateD1(db)
  const now=new Date().toISOString()
  await db.batch([
    db.prepare("INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned Worker','{}',?,?)").bind(now,now),
    db.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Owned','Admin','administrator','[]',?,?)").bind(now,now),
    db.prepare("INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(2,'owned@example.test',1,?,?,?)").bind(now,now,now),
    db.prepare("INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'C','USD',?,?)").bind(now,now),
    db.prepare("INSERT INTO projects(id,name,client_id,created_at,updated_at) VALUES(1,'P',1,?,?)").bind(now,now),
    db.prepare("INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'T',?,?)").bind(now,now),
    db.prepare('INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(1,2,?,?)').bind(now,now),
    db.prepare('INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,?,?)').bind(now,now),
  ])
  const session=await createD1SessionStore(db).issue(2),authority={userId:2,sessionRowId:session.session.id}
  let failDelete=false,afterGet:(()=>Promise<void>)|null=null
  const wrapped=new Proxy(bucket,{get(target,key){if(key==='delete')return async(...args:Parameters<R2Bucket['delete']>)=>{if(failDelete)throw new Error('owned deletion failure');return target.delete(...args)};if(key==='get')return async(...args:[string])=>{const value=await target.get(...args);await afterGet?.();return value};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v}}) as unknown as R2Bucket
  const stats:{calls:number;phase:'seal'|'row'}[]=[]
  const staging=createWorkerCsvStaging(db,wrapped,new Uint8Array(32).fill(3))
  const upload=()=>staging.port.upload(authority,chunks(),{sha256:sha256Hex(bytes),bytes:bytes.length},new AbortController().signal)
  const map=async()=>{const run=await upload();return staging.port.map(authority,run.id,{version:run.version,workspace_identity:'owned-worker',exporter_zone:'UTC',date_format:'iso',destination_interpretation:'source_wall_time',currency_policy:'destination_rates',mapping:{},excluded_lines:[]})}
  const business=async()=>JSON.stringify((await db.batch(['users','user_emails','clients','projects','tasks','user_assignments','task_assignments','time_entries'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY id`)))).map(result=>result.results))
  return{db,bucket,staging,authority,map,business,stats,apply:createWorkerCsvApply(db,wrapped,new Uint8Array(32).fill(3),{onInvocation:value=>stats.push(value)}),setFailDelete:(value:boolean)=>{failDelete=value},setAfterGet:(value:()=>Promise<void>)=>{afterGet=value}}
}

const prepare=async(f:Awaited<ReturnType<typeof fixture>>)=>{
  const run=await f.map(),preview=await f.staging.port.preview(f.authority,run.id,undefined,new AbortController().signal)
  const command={command_id:crypto.randomUUID(),preview_id:preview.preview_id,version:preview.run.version,expected_selected_rows:preview.tallies.selected_rows,expected_source_seconds:preview.tallies.source_seconds,expected_destination_seconds:preview.tallies.destination_seconds,acknowledge_exclusions:false,acknowledge_destination_difference:true,acknowledge_new_people:true}
  await f.apply.port.apply(f.authority,run.id,command)
  return {run,preview,command}
}
it('applies through the real native D1 writer and replays the exact command without duplicate time',async()=>{
  const f=await fixture(),input=await prepare(f)
  expect(await f.db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({n:0})
  for(let step=0;step<10;step++){await f.apply.execute(input.run.id);if((await f.apply.port.status(f.authority,input.run.id)).state==='completed')break}
  const done=await f.apply.port.status(f.authority,input.run.id)
  expect(done,JSON.stringify(f.stats)).toMatchObject({state:'completed',committed_rows:2,inserted_rows:2,source_seconds_committed:7200,destination_seconds:7200})
  await f.apply.port.apply(f.authority,input.run.id,input.command);await f.apply.execute(input.run.id)
  expect(await f.db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({n:2})
  expect(await f.db.prepare('SELECT DISTINCT actor_user_id FROM csv_import_chunks').all()).toMatchObject({results:[{actor_user_id:2}]})
})
it('fences future D1 chunks when cancelled after partial progress',async()=>{
  const f=await fixture(),input=await prepare(f)
  await f.apply.execute(input.run.id)
  const before=await f.db.prepare('SELECT count(*) AS n FROM time_entries').first<{n:number}>()
  expect(before!.n).toBeLessThan(2)
  await f.apply.port.cancel(f.authority,input.run.id,{command_id:crypto.randomUUID()})
  await f.apply.execute(input.run.id)
  expect((await f.apply.port.status(f.authority,input.run.id)).state).toBe('cancelled')
  expect(await f.db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual(before)
})
it('pauses for changed destination policy or revoked native authority before a D1 write',async()=>{
  const f=await fixture(),input=await prepare(f)
  await f.db.prepare("UPDATE organizations SET currency='EUR' WHERE id=1").run()
  await f.apply.execute(input.run.id)
  expect(await f.apply.port.status(f.authority,input.run.id)).toMatchObject({state:'paused',code:'policy_changed',committed_rows:0})
  expect(await f.db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({n:0})
})

it('continues bounded new-entity setup without starving the canonical time commit',async()=>{
  const f=await fixture()
  const fresh=new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll('owned@example.test','new-person@example.test').replaceAll(',C,P,T,',',New C,New P,New T,'))
  const upload=await f.staging.port.upload(f.authority,(async function*(){yield fresh})(),{sha256:sha256Hex(fresh),bytes:fresh.length},new AbortController().signal)
  const mapped=await f.staging.port.map(f.authority,upload.id,{version:upload.version,workspace_identity:'owned-worker',exporter_zone:'UTC',date_format:'iso',destination_interpretation:'source_wall_time',currency_policy:'destination_rates',mapping:{people:{'new-person@example.test':{create:{firstName:'New',lastName:'Person'}}}},excluded_lines:[]})
  const preview=await f.staging.port.preview(f.authority,mapped.id,undefined,new AbortController().signal)
  expect(preview.tallies.rejected_row_count).toBe(0)
  const command={command_id:crypto.randomUUID(),preview_id:preview.preview_id,version:preview.run.version,expected_selected_rows:preview.tallies.selected_rows,expected_source_seconds:preview.tallies.source_seconds,expected_destination_seconds:preview.tallies.destination_seconds,acknowledge_exclusions:false,acknowledge_destination_difference:true,acknowledge_new_people:true}
  await f.apply.port.apply(f.authority,mapped.id,command)
  for(let step=0;step<20;step++){await f.apply.execute(mapped.id);if((await f.apply.port.status(f.authority,mapped.id)).state==='completed')break}
  expect(await f.apply.port.status(f.authority,mapped.id),JSON.stringify(f.stats)).toMatchObject({state:'completed',committed_rows:2})
  expect(Math.max(...f.stats.map(value=>value.calls))).toBeLessThanOrEqual(40)
  expect(await f.db.prepare('SELECT count(*) AS n FROM csv_import_setup').first()).toEqual({n:6})
})
