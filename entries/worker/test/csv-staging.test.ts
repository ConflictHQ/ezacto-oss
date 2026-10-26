import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { migrateD1, createD1SessionStore } from '@ezacto/db'
import { createWorkerCsvStaging } from '../src/csv-staging.js'
import { sha256Hex } from '../../../packages/migrate/src/portable-hash.js'
const fixtures:Miniflare[]=[]
afterEach(async()=>{await Promise.all(fixtures.splice(0).map(f=>f.dispose()))})
const bytes=new TextEncoder().encode('Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\nowned@example.test,C,P,T,Owned private note,Yes,2026-09-01,09:00:00,2026-09-01,10:00:00,01:00:00\n')
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
  let lostAck:string|null=null
  const faultStatement=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
    if(key==='bind')return(...values:unknown[])=>faultStatement(target.bind(...values),sql)
    if(key==='first')return async(...args:unknown[])=>{const value=await (target.first as (...args:unknown[])=>Promise<unknown>)(...args);if(lostAck&&sql.includes(lostAck)){lostAck=null;throw new Error('Owned D1 acknowledgement lost')}return value}
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }})
  const faultDatabase=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>faultStatement(target.prepare(sql) as unknown as D1PreparedStatement,sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}}) as unknown as D1Database
  const staging=createWorkerCsvStaging(faultDatabase,wrapped,new Uint8Array(32).fill(3))
  const upload=()=>staging.port.upload(authority,chunks(),{sha256:sha256Hex(bytes),bytes:bytes.length},new AbortController().signal)
  const map=async()=>{const run=await upload();return staging.port.map(authority,run.id,{version:run.version,workspace_identity:'owned-worker',exporter_zone:'UTC',date_format:'iso',destination_interpretation:'source_wall_time',currency_policy:'destination_rates',mapping:{},excluded_lines:[]})}
  const business=async()=>JSON.stringify((await db.batch(['users','user_emails','clients','projects','tasks','user_assignments','task_assignments','time_entries'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY id`)))).map(result=>result.results))
  return{db,bucket,staging,authority,map,business,setLostAck:(value:string)=>{lostAck=value},setFailDelete:(value:boolean)=>{failDelete=value},setAfterGet:(value:()=>Promise<void>)=>{afterGet=value}}
}
it('builds a real D1/R2 immutable preview without native business writes or object URLs',async()=>{
  const f=await fixture(),run=await f.map(),before=await f.business()
  const preview=await f.staging.port.preview(f.authority,run.id,undefined,new AbortController().signal)
  expect(preview.tallies).toMatchObject({new_rows:1,selected_rows:1,source_seconds:3600,destination_seconds:3600,rejected_row_count:0})
  expect(preview.organization_name).toBe('Owned Worker')
  expect(await f.business()).toBe(before)
  expect(JSON.stringify(preview)).not.toContain('csv-private/')
  expect((await f.bucket.list()).objects.length).toBe(3)
  expect(await f.staging.port.catalog(f.authority,run.id,{kind:'people',previewId:preview.preview_id,limit:25})).toMatchObject({total:1})
  await f.db.prepare("UPDATE organizations SET currency='EUR' WHERE id=1").run()
  await expect(f.staging.port.preview(f.authority,run.id,preview.preview_id,new AbortController().signal)).rejects.toMatchObject({code:'preview_stale'})
})
it('rechecks native authority after private R2 reads and refuses a late preview',async()=>{
  const f=await fixture(),run=await f.map()
  f.setAfterGet(async()=>{await createD1SessionStore(f.db).revoke(2,f.authority.sessionRowId)})
  await expect(f.staging.port.preview(f.authority,run.id,undefined,new AbortController().signal)).rejects.toMatchObject({code:'administrator_required'})
  expect(await f.db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({n:0})
  expect((await f.db.prepare('SELECT preview_id FROM csv_worker_stages').first())?.preview_id).toBeNull()
})
it('keeps R2 deletion custody on failure and safely retries explicit purge',async()=>{
  const f=await fixture(),run=await f.map();await f.staging.port.preview(f.authority,run.id,undefined,new AbortController().signal)
  f.setFailDelete(true)
  await expect(f.staging.port.purge(f.authority,run.id)).rejects.toThrow('owned deletion failure')
  expect((await f.staging.port.read(f.authority,run.id)).purge_allowed).toBe(true)
  f.setFailDelete(false);await f.staging.port.purge(f.authority,run.id)
  expect((await f.bucket.list()).objects).toEqual([])
  expect((await f.staging.port.read(f.authority,run.id)).purge_allowed).toBe(false)
})

it('retains referenced R2 bytes after a committed upload response is lost',async()=>{
  const f=await fixture();f.setLostAck('INSERT INTO csv_worker_stages')
  await expect(f.staging.port.upload(f.authority,chunks(),{sha256:sha256Hex(bytes),bytes:bytes.length},new AbortController().signal)).rejects.toThrow('Owned D1 acknowledgement lost')
  const row=await f.db.prepare('SELECT object_key FROM csv_worker_stages').first<{object_key:string}>()
  expect(row).not.toBeNull();expect(await f.bucket.get(row!.object_key)).not.toBeNull()
})
it('retains new mapping and preview objects after their successful CAS replies are lost',async()=>{
  const f=await fixture(),run=await f.staging.port.upload(f.authority,chunks(),{sha256:sha256Hex(bytes),bytes:bytes.length},new AbortController().signal)
  f.setLostAck('choices_key=?')
  await expect(f.staging.port.map(f.authority,run.id,{version:run.version,workspace_identity:'owned-worker',exporter_zone:'UTC',date_format:'iso',destination_interpretation:'source_wall_time',currency_policy:'destination_rates',mapping:{},excluded_lines:[]})).rejects.toThrow('Owned D1 acknowledgement lost')
  expect((await f.staging.port.mapping(f.authority,run.id)).choices?.workspace_identity).toBe('owned-worker')
  f.setLostAck('preview_key=?')
  await expect(f.staging.port.preview(f.authority,run.id,undefined,new AbortController().signal)).rejects.toThrow('Owned D1 acknowledgement lost')
  const saved=await f.staging.port.read(f.authority,run.id)
  expect((await f.staging.port.preview(f.authority,run.id,saved.preview_id!,new AbortController().signal)).tallies.new_rows).toBe(1)
})
