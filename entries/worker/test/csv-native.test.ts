import type { CsvStagingRunData, CsvStagingPreview, CsvApplyRunData } from '@ezacto/api'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { migrateD1, createD1SessionStore } from '@ezacto/db'
import { sha256Hex } from '../../../packages/migrate/src/portable-hash.js'
let fixture:Miniflare|undefined
afterEach(async()=>{await fixture?.dispose();fixture=undefined})
it('runs the actual Worker API, private R2 and Queue chain with lost publication, replay and bounded calls',async()=>{
  const output=await build({stdin:{resolveDir:new URL('../',import.meta.url).pathname,contents:`
    import {worker} from './src/index.ts'
    const observe=(db)=>{let calls=0,budgetProgress=-1;const originals=new WeakMap();const wrap=(p,sql)=>{const s={bind:(...v)=>{if(sql.includes('SET budget_yields='))budgetProgress=Number(v[1]);return wrap(p.bind(...v),sql)},first:(...v)=>{calls++;return p.first(...v)},all:(...v)=>{calls++;return p.all(...v)},run:(...v)=>{calls++;return p.run(...v)},raw:(...v)=>{calls++;return p.raw(...v)}};originals.set(s,p);return s};return{database:{prepare:sql=>wrap(db.prepare(sql),sql),batch:items=>{calls++;return db.batch(items.map(s=>originals.get(s)||s))},exec:sql=>{calls++;return db.exec(sql)}},calls:()=>calls,budgetProgress:()=>budgetProgress}}

    let losePublication=true
    export default{
      async fetch(request,env,ctx){const url=new URL(request.url)
        if(url.pathname==='/__fixture/repair'){await env.CSV_IMPORT_QUEUE.send({kind:'csv-maintenance',phase:'publish'});return new Response(null,{status:204})}
        if(url.pathname==='/__fixture/duplicate'){const body=await request.json();await env.CSV_IMPORT_QUEUE.send({kind:'csv-import',stage_id:body.stage_id});await env.CSV_IMPORT_QUEUE.send({kind:'csv-import',stage_id:body.stage_id});return new Response(null,{status:204})}
        const queue=new Proxy(env.CSV_IMPORT_QUEUE,{get(target,key){if(key==='send')return async(body,options)=>{if(losePublication&&body.kind==='csv-import'){losePublication=false;throw new Error('owned publication unavailable')}return target.send(body,options)};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
        return worker.fetch(request,{...env,CSV_IMPORT_QUEUE:queue},ctx)
      },
      async queue(batch,env,ctx){const measured=observe(env.DB);try{await worker.queue(batch,{...env,DB:measured.database},ctx)}catch(error){await env.DB.prepare('INSERT INTO csv_fixture_errors(message) VALUES(?)').bind(String(error)).run();throw error}finally{await env.DB.prepare('INSERT INTO csv_fixture_calls(calls,budget_progress) VALUES(?,?)').bind(measured.calls(),measured.budgetProgress()).run()}}
    }`},bundle:true,conditions:['development'],platform:'browser',format:'esm',external:['node:async_hooks'],write:false,logLevel:'silent'})
  fixture=new Miniflare({modules:true,script:output.outputFiles[0]!.text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_als'],d1Databases:['DB'],r2Buckets:['ATTACHMENTS'],queueProducers:{CSV_IMPORT_QUEUE:'owned-csv-native'},queueConsumers:{'owned-csv-native':{maxBatchSize:1,maxBatchTimeout:0,retryDelay:0}},bindings:{ENVIRONMENT:'test',RELEASE:'owned-csv-native',APP_BASE_URL:'https://owned-csv.example',API_CURSOR_SIGNING_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',CSV_IMPORT_QUEUE_NAME:'owned-csv-native'}})
  const db=await fixture.getD1Database('DB'),bucket=await fixture.getR2Bucket('ATTACHMENTS'),now=new Date().toISOString()
  await migrateD1(db)
  await db.prepare('CREATE TABLE csv_fixture_calls(calls INTEGER NOT NULL,budget_progress INTEGER NOT NULL)').run()
  await db.prepare('CREATE TABLE csv_fixture_errors(message TEXT NOT NULL)').run()
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
  const session=await createD1SessionStore(db).issue(2)
  const request=(path:string,init:RequestInit={})=>fixture!.dispatchFetch('https://owned-csv.example'+path,{...init,headers:{origin:'https://owned-csv.example',cookie:`__Host-ezacto_session=${session.token}`,...init.headers}} as Parameters<Miniflare['dispatchFetch']>[1])
  const json=async<T>(path:string,body:unknown,method='POST',headers:Record<string,string>={})=>{const response=await request(path,{method,headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});expect(response.status,await response.clone().text()).toBe(200);return (await response.json()) as {data:T}}
  const capability=await request('/api/v1/csv-import-capabilities');expect(await capability.json()).toMatchObject({data:{runtime:'worker',staging_supported:true,apply_supported:true}})
  const bytes=new TextEncoder().encode('Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\nowned@example.test,C,P,T,Owned native note,Yes,2026-09-01,09:00:00,2026-09-01,10:00:00,01:00:00\nowned@example.test,C,P,T,Owned native second,Yes,2026-09-02,09:00:00,2026-09-02,10:00:00,01:00:00\n')
  const uploaded=await request('/api/v1/csv-imports',{method:'POST',headers:{'content-type':'application/octet-stream','x-csv-bytes':String(bytes.length),'x-csv-sha256':sha256Hex(bytes)},body:bytes})
  expect(uploaded.status,await uploaded.clone().text()).toBe(201);const stage=(await uploaded.json() as {data:CsvStagingRunData}).data
  await json(`/api/v1/csv-imports/${stage.id}/mapping`,{version:stage.version,workspace_identity:'owned-native',exporter_zone:'UTC',date_format:'iso',destination_interpretation:'source_wall_time',currency_policy:'destination_rates',mapping:{},excluded_lines:[]},'PATCH')
  const preview=(await json<CsvStagingPreview>(`/api/v1/csv-imports/${stage.id}/preview`,{})).data
  expect(await db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({n:0})
  const command={command_id:crypto.randomUUID(),preview_id:preview.preview_id,version:preview.run.version,expected_selected_rows:2,expected_source_seconds:7200,expected_destination_seconds:7200,acknowledge_exclusions:false,acknowledge_destination_difference:true,acknowledge_new_people:true}
  const applied=await json<CsvApplyRunData>(`/api/v1/csv-imports/${stage.id}/apply`,command,'POST',{'idempotency-key':command.command_id});expect(applied.data.state).toBe('queued')
  expect((await db.prepare('SELECT publish_pending FROM csv_worker_stages WHERE id=?').bind(stage.id).first())?.publish_pending).toBe(1)
  expect(await db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({n:0})
  await (await fixture.getQueueProducer('CSV_IMPORT_QUEUE')).send({kind:'csv-maintenance',phase:'publish'})
  await expect.poll(async()=> (await db.prepare('SELECT count(*) AS n FROM csv_fixture_calls').first())?.n,{timeout:5000}).toBeGreaterThan(0)
  try {await expect.poll(async()=> (await db.prepare('SELECT status FROM csv_worker_stages WHERE id=?').bind(stage.id).first())?.status,{timeout:30000}).toBe('completed')} catch(error) {
    console.error('Owned queue diagnostics',await db.prepare('SELECT status,native_run_id,attempts,safe_code,publish_pending,next_attempt_at,lease_holder,lease_expires_at FROM csv_worker_stages').all(),await db.prepare('SELECT * FROM csv_fixture_calls').all(),await db.prepare('SELECT * FROM csv_fixture_errors').all());throw error
  }
  await json(`/api/v1/csv-imports/${stage.id}/apply`,command,'POST',{'idempotency-key':command.command_id})
  await request('/__fixture/duplicate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stage_id:stage.id})})
  await expect.poll(async()=> (await db.prepare('SELECT count(*) AS n FROM csv_fixture_calls').first())?.n,{timeout:10000}).toBeGreaterThanOrEqual(5)
  expect(await db.prepare('SELECT count(*) AS n,sum(rounded_seconds) AS seconds FROM time_entries').first()).toEqual({n:2,seconds:7200})
  const calls=(await db.prepare('SELECT calls FROM csv_fixture_calls').all<{calls:number}>()).results.map(r=>r.calls)
  expect(Math.max(...calls),JSON.stringify(calls)).toBeLessThanOrEqual(50)
  // Existing-entity rows create no setup: positive durable progress here proves
  // the real budget catch ran after committing time, then resumed without duplicates.
  expect((await db.prepare('SELECT max(budget_progress) AS progress FROM csv_fixture_calls').first<{progress:number}>())?.progress).toBeGreaterThanOrEqual(1)
  expect((await bucket.list()).objects.every(object=>object.key.startsWith('csv-private/'))).toBe(true)
  const deleted=await request(`/api/v1/csv-imports/${stage.id}/input`,{method:'DELETE'});expect(deleted.status).toBe(204)
  expect((await bucket.list()).objects).toEqual([])
  expect(await db.prepare('SELECT count(*) AS n FROM time_entries').first()).toEqual({n:2})
},60000)
