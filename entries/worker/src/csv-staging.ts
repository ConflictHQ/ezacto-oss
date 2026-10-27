import { CsvStagingError, CsvByteBudget, CSV_RAW_RETENTION_MS, type CsvImportStagingPort, type CsvStagingAuthority, type CsvStagingRunData, type CsvStagingChoices, type CsvStagingDiagnostic } from '@ezacto/api'
import { createD1Database, createCsvBrowserDatasetLedger, createTimesheetLockPolicyRepository, DrizzleTrackedResourceRepository, csvStagingSessionFence } from '@ezacto/db/d1'
import { CsvBrowserLedgerRefusal } from '@ezacto/core'
import { parseCsv } from '../../../packages/migrate/src/csv-contract.js'
import { createClockifyBrowserAdapter, CLOCKIFY_ADAPTERS } from '../../../packages/migrate/src/csv-clockify.js'
import { parseBrowserMapping } from '../../../packages/migrate/src/csv-browser-mapping.js'
import { CsvBrowserPlannerError, assertCsvExporterZone } from '../../../packages/migrate/src/csv-browser-errors.js'
import { readD1CsvDestinationSnapshot } from '../../../packages/migrate/src/csv-browser-d1.js'
import { csvCatalog, csvDiagnostic, csvTallies, type CsvPreviewResult } from '../../../packages/migrate/src/csv-staging-presentation.js'
import { sha256Hex } from '../../../packages/migrate/src/portable-hash.js'

export interface WorkerCsvStage {
  id: string; target_nonce: string; owner_id: number|null; version: number; status: string
  file_sha256: string; file_bytes: number; object_key: string|null; choices_key: string|null; preview_key: string|null; preview_id: string|null; source_id: string|null; summary_json: string|null
  revision: number; policy_hash:string|null; native_run_id: number|null; session_id:number|null; command_id:string|null; confirmation_id:string|null; command_json:string|null; cancellation_id:string|null
  budget_yields:number;budget_progress:number;last_published_at:string|null;lease_generation:number; lease_holder:string|null; lease_expires_at:string|null; attempts:number; next_attempt_at:string|null; safe_code:string|null; created_at:string;expires_at:string;finished_at:string|null;publish_pending:number
}
export interface WorkerCsvPreview extends CsvPreviewResult { choices: CsvStagingChoices; diagnostics: CsvStagingDiagnostic[]; catalog: ReturnType<typeof csvCatalog>; revision:number }
function fail(code: ConstructorParameters<typeof CsvStagingError>[0]):never { throw new CsvStagingError(code) }
const id = () => crypto.randomUUID().replaceAll('-','')
const keyFor = (nonce:string,stage:string) => `csv-private/${nonce}/${stage}/${id()}`
const rawStatus = (row:WorkerCsvStage):CsvStagingRunData['status'] => ['queued','running','paused','partial'].includes(row.status)?'confirmed':row.status as CsvStagingRunData['status']

/** Private R2-backed staging. All credentials remain native session row references. */
export const createWorkerCsvStaging = (database:D1Database, bucket:R2Bucket, cursorKey:Uint8Array) => {
  const macKey = crypto.subtle.importKey('raw',cursorKey as BufferSource,{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const nonce = async () => (await database.prepare('SELECT nonce FROM csv_staging_instance WHERE singleton=1').first<{nonce:string}>())?.nonce ?? fail('storage_unavailable')
  const revision = async () => (await database.prepare('SELECT revision FROM csv_worker_revision WHERE singleton=1').first<{revision:number}>())?.revision ?? fail('storage_unavailable')
  const authorize = async (authority:CsvStagingAuthority,target?:string) => {
    const guard=csvStagingSessionFence(authority,target??null)
    if((await database.prepare(`SELECT (${guard.sql}) AS allowed`).bind(...guard.params).first<{allowed:number}>())?.allowed!==1) fail('administrator_required')
  }
  const read = async (stageId:string) => await database.prepare('SELECT * FROM csv_worker_stages WHERE id=?').bind(stageId).first<WorkerCsvStage>()
  const owned = async (authority:CsvStagingAuthority,stageId:string):Promise<WorkerCsvStage> => {
    await authorize(authority)
    if(!/^csv_[a-f0-9]{32}$/.test(stageId)) fail('run_not_found')
    const row=await read(stageId)
    if(!row||row.owner_id!==authority.userId||row.target_nonce!==await nonce()) fail('run_not_found')
    return row
  }
  const cas = async (authority:CsvStagingAuthority,row:WorkerCsvStage,sql:string,params:unknown[],expectedRevision?:number):Promise<WorkerCsvStage> => {
    const guard=csvStagingSessionFence(authority,row.target_nonce)
    const result=await database.prepare(`UPDATE csv_worker_stages SET ${sql},version=version+1 WHERE id=? AND version=? AND (${guard.sql}) ${expectedRevision===undefined?'':'AND (SELECT revision FROM csv_worker_revision WHERE singleton=1)=?'} RETURNING *`).bind(...params,row.id,row.version,...guard.params,...(expectedRevision===undefined?[]:[expectedRevision])).first<WorkerCsvStage>()
    if(!result){await authorize(authority,row.target_nonce);fail('preview_stale')}
    return result
  }
  const current = async (authority:CsvStagingAuthority,row:WorkerCsvStage):Promise<WorkerCsvStage> => {
    const guard=csvStagingSessionFence(authority,row.target_nonce)
    const now=await database.prepare(`SELECT * FROM csv_worker_stages WHERE id=? AND version=? AND owner_id=? AND target_nonce=? AND (${guard.sql})`).bind(row.id,row.version,authority.userId,row.target_nonce,...guard.params).first<WorkerCsvStage>()
    if(!now){await authorize(authority,row.target_nonce);fail('preview_stale')}
    return now
  }
  const inputAllowed=(row:WorkerCsvStage)=>{if(!row.object_key||row.status==='purged'||Date.parse(row.expires_at)<=Date.now())fail('preview_stale')}
  const object = async(row:WorkerCsvStage,key:string|null)=>{
    if(!key||!key.startsWith(`csv-private/${row.target_nonce}/${row.id}/`))fail('storage_unavailable')
    const value=await bucket.get(key);if(!value)fail('storage_unavailable');return value
  }
  const json = async<T>(row:WorkerCsvStage,key:string|null):Promise<T>=> { try{return JSON.parse(await (await object(row,key)).text()) as T}catch{fail('storage_unavailable')} }
  const representation=async(row:WorkerCsvStage):Promise<CsvStagingRunData>=>({
    id:row.id,status:rawStatus(row),version:row.version,file_sha256:row.file_sha256,bytes:row.file_bytes,staging_expires_at:row.expires_at,retention_deadline:row.finished_at?new Date(Math.min(Date.parse(row.expires_at),Date.parse(row.finished_at)+CSV_RAW_RETENTION_MS)).toISOString():null,
    purge_allowed:!['confirmed','queued','running','paused','partial'].includes(row.status)&&(row.status!=='purged'||!!(row.object_key||row.choices_key||row.preview_key)),
    allowed_actions:['staged','previewed'].includes(row.status)?Date.parse(row.expires_at)>Date.now()?['map','preview','purge']:['purge']:row.status==='purged'&&(row.object_key||row.choices_key||row.preview_key)?['purge']:[],
    retryable:['staged','previewed'].includes(row.status),preview_id:row.preview_id,preview_stale:row.revision!==await revision()||Date.parse(row.expires_at)<=Date.now(),source_id:row.source_id,tallies:row.summary_json?JSON.parse(row.summary_json):null,
  })
  const page=async<T>(items:T[],previewId:string,scope:string,limit:number,cursor?:string)=>{
    if(!Number.isInteger(limit)||limit<1||limit>100)fail('mapping_invalid')
    let offset=0
    const sign=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',await macKey,new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('')
    if(cursor){const[body,signature]=cursor.split('.');if(!body||signature!==await sign(body))fail('preview_stale');try{const p=JSON.parse(atob(body));if(p.preview!==previewId||p.scope!==scope||p.limit!==limit||!Number.isSafeInteger(p.offset)||p.offset<0)fail('preview_stale');offset=p.offset}catch{fail('preview_stale')}}
    const body=offset+limit<items.length?btoa(JSON.stringify({preview:previewId,scope,limit,offset:offset+limit})):null
    return{items:items.slice(offset,offset+limit),total:items.length,next_cursor:body?`${body}.${await sign(body)}`:null,preview_id:previewId}
  }
  const saved=async(authority:CsvStagingAuthority,row:WorkerCsvStage,previewId?:string)=>{inputAllowed(row);if(!row.preview_key||!row.preview_id||(previewId&&previewId!==row.preview_id))fail('preview_stale');const value=await json<WorkerCsvPreview>(row,row.preview_key);await current(authority,row);return value}
  const discardKnownUnreferenced=async(key:string)=>{
    try{const referenced=await database.prepare('SELECT 1 FROM csv_worker_stages WHERE object_key=? OR choices_key=? OR preview_key=? LIMIT 1').bind(key,key,key).first();if(!referenced)await bucket.delete(key)}catch{/* Unknown persistence leaves custody to the bounded orphan sweep. */}
  }
  const putJson=async(row:WorkerCsvStage,value:unknown)=>{const key=keyFor(row.target_nonce,row.id),text=JSON.stringify(value);if(new TextEncoder().encode(text).length>24*1024*1024)fail('mapping_too_large');await bucket.put(key,text);return key}
  const purgeRow=async(authority:CsvStagingAuthority,row:WorkerCsvStage)=>{
    if(['confirmed','queued','running','paused','partial'].includes(row.status)&&row.native_run_id){const native=await database.prepare('SELECT browser_state,source_id,finished_at FROM csv_import_runs WHERE id=?').bind(row.native_run_id).first<{browser_state:string;source_id:string;finished_at:string|null}>();if(native&&native.source_id===row.source_id&&['complete','cancelled'].includes(native.browser_state))row=await cas(authority,row,'status=?,finished_at=coalesce(finished_at,?)',[native.browser_state==='complete'?'completed':'cancelled',native.finished_at??new Date().toISOString()])}
    if(['confirmed','queued','running','paused','partial'].includes(row.status))fail('run_busy')
    if(row.status!=='purged')row=await cas(authority,row,"status='purged',preview_id=NULL,finished_at=coalesce(finished_at,?)",[new Date().toISOString()])
    const prefix=`csv-private/${row.target_nonce}/${row.id}/`
    const objects=await bucket.list({prefix,limit:100})
    if(objects.objects.length)await bucket.delete(objects.objects.map(object=>object.key))
    await current(authority,row)
    if(objects.truncated)fail('storage_unavailable')
    await cas(authority,row,'object_key=NULL,choices_key=NULL,preview_key=NULL',[])
  }
  const port:CsvImportStagingPort={
    runtime:'worker',authorize,authorizeRun:async(a,run)=>{await owned(a,run)},
    async upload(authority,body,expected,signal){
      await authorize(authority);if(expected.bytes<1||expected.bytes>5242880||!/^[a-f0-9]{64}$/.test(expected.sha256))fail('length_mismatch')
      const target=await nonce(),stageId=`csv_${id()}`,key=keyFor(target,stageId),budget=new CsvByteBudget(),parts:Uint8Array[]=[]
      for await(const part of body){if(signal.aborted)fail('upload_aborted');budget.take(part);parts.push(part)}
      const bytes=new Uint8Array(parts.reduce((sum,part)=>sum+part.byteLength,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
      if(bytes.length!==expected.bytes)fail('length_mismatch');if(sha256Hex(bytes)!==expected.sha256)fail('hash_mismatch')
      const parsed=parseCsv(bytes,createClockifyBrowserAdapter({exporterZone:'UTC'}))
      if(parsed.fileErrors.some(x=>['invalid_utf8','not_utf8','binary_content'].includes(x.code)))fail('not_csv')
      if(parsed.fileErrors.some(x=>['too_many_rows','too_many_columns','field_too_long','name_too_long'].includes(x.code)))fail('file_too_large')
      await bucket.put(key,bytes)
      try{await authorize(authority,target);if(signal.aborted)fail('upload_aborted')
        const guard=csvStagingSessionFence(authority,target),now=new Date().toISOString()
        const row=await database.prepare(`INSERT INTO csv_worker_stages(id,target_nonce,owner_id,status,file_sha256,file_bytes,object_key,revision,created_at,expires_at)
          SELECT ?,?,?,'staged',?,?,?,revision,?,? FROM csv_worker_revision WHERE singleton=1 AND (${guard.sql}) RETURNING *`).bind(stageId,target,authority.userId,expected.sha256,expected.bytes,key,now,new Date(Date.now()+CSV_RAW_RETENTION_MS).toISOString(),...guard.params).first<WorkerCsvStage>()
        if(!row)fail('administrator_required');return representation(row)
      }catch(error){if(error instanceof CsvStagingError)await discardKnownUnreferenced(key);throw error}
    },
    async read(a,run){return representation(await owned(a,run))},
    async mapping(a,run){const row=await owned(a,run);inputAllowed(row);const choices=row.choices_key?await json<CsvStagingChoices>(row,row.choices_key):null;await current(a,row);return{version:row.version,preview_id:row.preview_id,choices}},
    async map(a,run,input){
      const row=await owned(a,run);inputAllowed(row)
      if(!['staged','previewed','paused','partial'].includes(row.status)||input.version!==row.version)fail('preview_stale')
      if(Object.keys(input).some(k=>!['workspace_identity','exporter_zone','date_format','destination_interpretation','currency_policy','mapping','excluded_lines','version'].includes(k))||typeof input.workspace_identity!=='string'||!input.workspace_identity.trim()||input.workspace_identity.length>255||input.date_format!=='iso'||input.destination_interpretation!=='source_wall_time'||input.currency_policy!=='destination_rates'||!Array.isArray(input.excluded_lines)||input.excluded_lines.length>50000)fail('mapping_invalid')
      let mapping;try{assertCsvExporterZone(input.exporter_zone);mapping=parseBrowserMapping(JSON.stringify(input.mapping))}catch{fail('mapping_invalid')}
      const exclusions=[...new Set(input.excluded_lines)].sort((a,b)=>a-b);if(exclusions.some(x=>!Number.isSafeInteger(x)||x<2))fail('mapping_invalid')
      const orm=createD1Database(database),guard=csvStagingSessionFence(a,row.target_nonce)
      const ledger=createCsvBrowserDatasetLedger(orm,{tracked:new DrizzleTrackedResourceRepository(orm,createTimesheetLockPolicyRepository(orm)),now:()=>new Date(),authorityFence:()=>guard,destinationFence:()=>({sql:'0',params:[]}),setupFacts:()=>({sql:'NULL',params:[]})})
      let dataset:string;try{dataset=await ledger.registerDataset({kind:'administrator',userId:String(a.userId)},{workspaceIdentity:input.workspace_identity})}catch(error){if(error instanceof CsvBrowserLedgerRefusal)fail(error.code==='dataset_conflict'?'source_choice_required':'administrator_required');throw error}
      const choices:CsvStagingChoices={workspace_identity:input.workspace_identity,source_id:dataset,adapter_id:CLOCKIFY_ADAPTERS.browser,date_format:'iso',exporter_zone:input.exporter_zone,destination_interpretation:'source_wall_time',currency_policy:'destination_rates',excluded_lines:exclusions,mapping:mapping as unknown as Record<string,unknown>}
      if(row.confirmation_id){const old=await json<CsvStagingChoices>(row,row.choices_key);if(old.workspace_identity!==choices.workspace_identity||old.exporter_zone!==choices.exporter_zone||JSON.stringify(old.mapping)!==JSON.stringify(choices.mapping)||JSON.stringify(old.excluded_lines)!==JSON.stringify(choices.excluded_lines))fail('worker_policy_changed')}
      const key=await putJson(row,choices)
      try{const updated=await cas(a,await current(a,row),"choices_key=?,source_id=?,preview_key=NULL,preview_id=NULL,summary_json=NULL,status=CASE WHEN confirmation_id IS NULL THEN 'staged' ELSE 'paused' END,revision=(SELECT revision FROM csv_worker_revision WHERE singleton=1)",[key,dataset]);return representation(updated)}catch(error){if(error instanceof CsvStagingError)await discardKnownUnreferenced(key);throw error}
    },
    async preview(a,run,previewId,signal){
      const row=await owned(a,run);inputAllowed(row)
      if(previewId){const value=await saved(a,row,previewId);if(value.revision!==await revision())fail('preview_stale');return{organization_name:value.organizationName,preview_id:row.preview_id!,run:await representation(row),choices:value.choices,tallies:csvTallies(value.plan)}}
      if(!row.choices_key||!row.source_id)fail('source_choice_required')
      if(!['staged','previewed','paused','partial'].includes(row.status))fail('run_busy')
      const choices=await json<CsvStagingChoices>(row,row.choices_key),value=await object(row,row.object_key),bytes=new Uint8Array(await value.arrayBuffer())
      if(sha256Hex(bytes)!==row.file_sha256)fail('hash_mismatch');if(signal.aborted)fail('upload_aborted')
      let result:Awaited<ReturnType<typeof readD1CsvDestinationSnapshot>>;try{result=await readD1CsvDestinationSnapshot(database,{kind:'administrator',userId:String(a.userId)},row.source_id,bytes,{exporterZone:choices.exporter_zone,mapping:parseBrowserMapping(JSON.stringify(choices.mapping)),excludedLines:choices.excluded_lines})}catch(error){if(error instanceof CsvBrowserPlannerError&&error.code==='snapshot_budget_exceeded')fail('worker_budget_exceeded');throw error}
      if(row.confirmation_id&&result.policyHash!==row.policy_hash)fail('worker_policy_changed')
      const diagnostics=[...result.plan.plan.report.fileErrors.map(x=>csvDiagnostic(x,'file','invalid')),...result.plan.plan.report.rejected.map(x=>csvDiagnostic(x,'row',x.category)),...result.plan.plan.report.warnings.map(x=>csvDiagnostic(x,x.line<=1?'file':'row','warning'))]
      const data:WorkerCsvPreview={...result,choices,diagnostics,catalog:csvCatalog(result,choices)}
      const key=await putJson(row,data),preview=`preview_${sha256Hex(JSON.stringify([row.target_nonce,row.owner_id,row.file_sha256,choices,result.revision]))}`
      try{if(signal.aborted)fail('upload_aborted');const updated=await cas(a,await current(a,row),"preview_key=?,preview_id=?,summary_json=?,revision=?,policy_hash=?,safe_code=NULL,status=CASE WHEN confirmation_id IS NULL THEN 'previewed' ELSE 'paused' END",[key,preview,JSON.stringify(csvTallies(result.plan)),result.revision,result.policyHash],result.revision);return{organization_name:result.organizationName,preview_id:preview,run:await representation(updated),choices,tallies:csvTallies(result.plan)}}catch(error){if(error instanceof CsvStagingError)await discardKnownUnreferenced(key);throw error}
    },
    async errors(a,run,q){const row=await owned(a,run),value=await saved(a,row,q.previewId);return page(value.diagnostics.filter(x=>!q.kind||x.kind===q.kind),row.preview_id!,`errors:${q.kind??''}`,q.limit,q.cursor)},
    async catalog(a,run,q){const row=await owned(a,run),value=await saved(a,row,q.previewId);if(!q.sourceKey)return page(value.catalog.sources.filter(x=>x.kind===q.kind),row.preview_id!,`sources:${q.kind}`,q.limit,q.cursor)
      const source=value.catalog.sources.find(x=>x.source_key===q.sourceKey&&x.kind===q.kind);if(!source)fail('mapping_invalid');let candidates=value.catalog.candidates[q.kind]??[]
      if(q.kind==='projects'&&source.parent_source_key){const parent=value.catalog.sources.find(x=>x.source_key===source.parent_source_key);candidates=parent?.selected_id?candidates.filter(x=>x.parent_id===parent.selected_id):[]}
      return page(candidates,row.preview_id!,`candidates:${q.kind}:${q.sourceKey}`,q.limit,q.cursor)
    },
    async diagnostics(a,run,previewId){const row=await owned(a,run),value=await saved(a,row,previewId);return JSON.stringify({preview_id:row.preview_id,tallies:csvTallies(value.plan),diagnostics:value.diagnostics})},
    async purge(a,run){await purgeRow(a,await owned(a,run))},
  }
  const sweep=async()=>{
    const now=new Date().toISOString(),target=await nonce()
    const candidates=await database.prepare(`SELECT * FROM csv_worker_stages WHERE (object_key IS NOT NULL OR choices_key IS NOT NULL OR preview_key IS NOT NULL) AND (status='purged'
      OR expires_at<=? OR target_nonce<>? OR owner_id IS NULL OR EXISTS(SELECT 1 FROM account_closures WHERE user_id=owner_id))
      ORDER BY created_at LIMIT 5`).bind(now,target).all<WorkerCsvStage>()
    for(let row of candidates.results){
      const changed=await database.prepare("UPDATE csv_worker_stages SET status='purged',safe_code=CASE WHEN cancellation_id IS NOT NULL THEN 'cancelled_by_administrator' ELSE 'input_expired' END,publish_pending=0,lease_holder=NULL,lease_expires_at=NULL,version=version+1 WHERE id=? AND version=? RETURNING *").bind(row.id,row.version).first<WorkerCsvStage>()
      if(!changed)continue;row=changed
      const objects=await bucket.list({prefix:`csv-private/${row.target_nonce}/${row.id}/`,limit:100})
      if(objects.objects.length)await bucket.delete(objects.objects.map(object=>object.key))
      if(!objects.truncated)await database.prepare('UPDATE csv_worker_stages SET object_key=NULL,choices_key=NULL,preview_key=NULL,version=version+1 WHERE id=? AND version=?').bind(row.id,row.version).run()
    }
    const cursor=await database.prepare('SELECT orphan_cursor FROM csv_worker_revision WHERE singleton=1').first<{orphan_cursor:string|null}>()
    const listed=await bucket.list({prefix:'csv-private/',limit:100,...(cursor?.orphan_cursor?{cursor:cursor.orphan_cursor}:{})})
    const old=listed.objects.filter(value=>value.uploaded.getTime()<Date.now()-CSV_RAW_RETENTION_MS).map(value=>value.key)
    if(old.length){const known=await database.prepare(`SELECT object_key AS key FROM csv_worker_stages WHERE object_key IN(SELECT value FROM json_each(?)) UNION SELECT choices_key FROM csv_worker_stages WHERE choices_key IN(SELECT value FROM json_each(?)) UNION SELECT preview_key FROM csv_worker_stages WHERE preview_key IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(old),JSON.stringify(old),JSON.stringify(old)).all<{key:string}>();const keys=new Set(known.results.map(value=>value.key));const remove=old.filter(key=>!keys.has(key));if(remove.length)await bucket.delete(remove)}
    await database.prepare('UPDATE csv_worker_revision SET orphan_cursor=? WHERE singleton=1').bind(listed.truncated?listed.cursor:null).run()
  }
  return{port,owned,read,cas,current,representation,saved,revision,nonce,json,object,putJson,authorize,database,bucket,sweep}
}
