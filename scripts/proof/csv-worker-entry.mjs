// Disposable proof target only. Never imported by a production entry.
import worker from '../../entries/worker/src/index.ts'
import {migrateD1,createD1SessionStore} from '@ezacto/db/d1'
const json=value=>Response.json(value)
const observe=db=>{let calls=0;const originals=new WeakMap();const wrap=p=>{const s={bind:(...v)=>wrap(p.bind(...v)),first:(...v)=>{calls++;return p.first(...v)},all:(...v)=>{calls++;return p.all(...v)},run:(...v)=>{calls++;return p.run(...v)},raw:(...v)=>{calls++;return p.raw(...v)}};originals.set(s,p);return s};return{database:{prepare:sql=>wrap(db.prepare(sql)),batch:items=>{calls++;return db.batch(items.map(s=>originals.get(s)||s))},exec:sql=>{calls++;return db.exec(sql)}},calls:()=>calls}}
export default {
  async fetch(request,env,ctx){
    if(!env.PROOF_SECRET||request.headers.get('x-owned-proof')!==env.PROOF_SECRET)return new Response(null,{status:404})
    if(!/^ezacto-csv1184-proof-[a-f0-9]+$/.test(env.PROOF_ID??''))return new Response(null,{status:404})
    const url=new URL(request.url)
    if(url.pathname==='/__proof/seed'){
      try{
      await migrateD1(env.DB)
      const exists=await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();if(exists)return new Response(null,{status:409})
      const now=new Date().toISOString()
      await env.DB.batch([
        env.DB.prepare('CREATE TABLE csv_proof_calls(calls INTEGER NOT NULL)'),
        env.DB.prepare('CREATE TABLE csv_proof_control(singleton INTEGER PRIMARY KEY,lose_send INTEGER NOT NULL,hold_stage TEXT)'),
        env.DB.prepare('INSERT INTO csv_proof_control VALUES(1,1,NULL)'),
        env.DB.prepare("INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned CSV proof','{}',?,?)").bind(now,now),
        env.DB.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Owned','Admin','administrator','[]',?,?),(3,'Owned','Other','administrator','[]',?,?),(4,'Owned','Staff','employee','[]',?,?)").bind(now,now,now,now,now,now),
        env.DB.prepare("INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(2,'owned@example.test',1,?,?,?),(3,'other@example.test',1,?,?,?),(4,'staff@example.test',1,?,?,?)").bind(now,now,now,now,now,now,now,now,now),
        env.DB.prepare("INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'C','USD',?,?)").bind(now,now),
        env.DB.prepare("INSERT INTO projects(id,name,client_id,created_at,updated_at) VALUES(1,'P',1,?,?)").bind(now,now),
        env.DB.prepare("INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'T',?,?)").bind(now,now),
        env.DB.prepare('INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(1,2,?,?)').bind(now,now),
        env.DB.prepare('INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,?,?)').bind(now,now),
      ])
      const admin=await createD1SessionStore(env.DB).issue(2),other=await createD1SessionStore(env.DB).issue(3),staff=await createD1SessionStore(env.DB).issue(4)
      return json({admin:admin.token,other:other.token,staff:staff.token})
      }catch(error){return new Response(JSON.stringify({fixture_error:String(error)}),{status:500,headers:{'content-type':'application/json'}})}
    }
    if(url.pathname==='/__proof/inspect')return json({
      stages:(await env.DB.prepare('SELECT id,status,safe_code,publish_pending,native_run_id FROM csv_worker_stages ORDER BY created_at').all()).results,
      time:await env.DB.prepare('SELECT count(*) AS count,coalesce(sum(rounded_seconds),0) AS seconds FROM time_entries').first(),
      calls:(await env.DB.prepare('SELECT calls FROM csv_proof_calls').all()).results.map(row=>row.calls),
      objects:(await env.ATTACHMENTS.list({limit:100})).objects.map(object=>object.key),
      money:await env.DB.prepare('SELECT (SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM staff_payment_events) AS staff_payments').first(),
    })
    if(url.pathname==='/__proof/repair'){await env.CSV_IMPORT_QUEUE.send({kind:'csv-maintenance',phase:'publish'});return new Response(null,{status:204})}
    if(url.pathname==='/__proof/duplicate'){const {stage_id}=await request.json();await env.CSV_IMPORT_QUEUE.send({kind:'csv-import',stage_id});await env.CSV_IMPORT_QUEUE.send({kind:'csv-import',stage_id});return new Response(null,{status:204})}
    if(url.pathname==='/__proof/hold'){const {stage_id}=await request.json();await env.DB.prepare('UPDATE csv_proof_control SET hold_stage=? WHERE singleton=1').bind(stage_id??null).run();return new Response(null,{status:204})}
    const headers=new Headers(request.headers);headers.delete('x-owned-proof')
    const queue={send:async(body,options)=>{
      if(body.kind==='csv-import'){
        const lost=await env.DB.prepare('UPDATE csv_proof_control SET lose_send=0 WHERE singleton=1 AND lose_send=1 RETURNING singleton').first()
        if(lost)throw new Error('Owned proof lost publication')
      }
      return env.CSV_IMPORT_QUEUE.send(body,options)
    }}
    return worker.fetch(new Request(request,{headers}),{...env,CSV_IMPORT_QUEUE:queue},ctx)
  },
  async queue(batch,env,ctx){
    const control=await env.DB.prepare('SELECT hold_stage FROM csv_proof_control WHERE singleton=1').first()
    if(control?.hold_stage&&batch.messages.some(message=>message.body?.stage_id===control.hold_stage)){
      const stage=await env.DB.prepare('SELECT native_run_id FROM csv_worker_stages WHERE id=?').bind(control.hold_stage).first()
      if(stage?.native_run_id&&(await env.DB.prepare('SELECT count(*) AS n FROM csv_import_chunks WHERE run_id=?').bind(stage.native_run_id).first())?.n>=1){for(const message of batch.messages)message.retry({delaySeconds:5});return}
    }
    const measured=observe(env.DB)
    try{await worker.queue(batch,{...env,DB:measured.database},ctx)}finally{await env.DB.prepare('INSERT INTO csv_proof_calls(calls) VALUES(?)').bind(measured.calls()).run()}
  },
}
