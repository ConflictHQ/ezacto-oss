import { sha256Hex } from '../../../packages/migrate/src/portable-hash.js'
import { CsvInvocationBudget, csvInvocationDatabase } from './csv-budget.js'
import { CsvApplyRefusal, canonicalCsvApplyCommand, CsvBrowserLedgerRefusal, csvPlanId, type CsvApplyCommand, type CsvStagingAuthority } from '@ezacto/core'
import { csvStagingSessionFence } from '@ezacto/db/d1'
import type { CsvImportApplyPort, CsvApplyRunData } from '@ezacto/api'
import { createD1CsvBrowserService, readD1CsvDestinationSnapshot } from '../../../packages/migrate/src/csv-browser-d1.js'
import { csvBrowserSealInput } from '../../../packages/migrate/src/csv-planner.js'
import { CsvBrowserPlannerError } from '../../../packages/migrate/src/csv-browser-errors.js'
import { createWorkerCsvStaging, type WorkerCsvStage } from './csv-staging.js'

const terminal=new Set(['completed','cancelled','failed'])
const iso=()=>new Date().toISOString()
export const createWorkerCsvApply=(database:D1Database,bucket:R2Bucket,cursorKey:Uint8Array,options:{reportError?:(error:Error)=>void;onInvocation?:(stats:{calls:number;phase:'seal'|'row'})=>void}={})=>{
  const staging=createWorkerCsvStaging(database,bucket,cursorKey)
  const status:CsvImportApplyPort['status']=async(authority,stageId,commandId)=>{
    const row=await staging.owned(authority,stageId)
    const tallies=row.summary_json?JSON.parse(row.summary_json):null
    const native=row.native_run_id?await database.prepare('SELECT browser_state FROM csv_import_runs WHERE id=?').bind(row.native_run_id).first<{browser_state:string}>():null
    const completed=native?.browser_state==='complete'
    const state:CsvApplyRunData['state']=completed?'completed':row.cancellation_id||native?.browser_state==='cancelled'?'cancelled':row.status==='staged'||row.status==='previewed'?'not_confirmed':row.status==='purged'?row.command_id?'paused':'not_confirmed':row.status as CsvApplyRunData['state']
    const counters=row.native_run_id?await database.prepare(`SELECT count(*) AS committed_rows,coalesce(sum(c.inserted_rows),0) AS inserted_rows,coalesce(sum(c.already_imported_rows),0) AS already_imported_rows,coalesce(sum(c.source_seconds),0) AS source_seconds_committed,coalesce(sum(t.rounded_seconds),0) AS destination_seconds,coalesce(sum(CASE WHEN t.id IS NULL THEN 1 ELSE 0 END),0) AS deleted_imported_rows FROM csv_import_chunks c JOIN csv_import_runs r ON r.id=c.run_id JOIN csv_import_entries i ON i.source_id=r.source_id AND i.source_key=c.source_key LEFT JOIN time_entries t ON t.id=i.time_entry_id WHERE c.run_id=?`).bind(row.native_run_id).first<Record<string,number>>():null
    const setup=row.native_run_id?await database.prepare('SELECT count(*) AS n FROM csv_import_setup WHERE run_id=?').bind(row.native_run_id).first<{n:number}>():null
    const known=commandId?!!await database.prepare('SELECT 1 FROM csv_worker_commands WHERE stage_id=? AND command_id=? AND actor_id=?').bind(stageId,commandId,authority.userId).first():!!row.command_id
    const pending=terminal.has(state)?null:row.command_json?canonicalCsvApplyCommand(JSON.parse(row.command_json)).command:null
    const actions:CsvApplyRunData['allowed_actions']=terminal.has(state)?['inspect','purge']:state==='not_confirmed'?['inspect','apply']:state==='paused'||state==='partial'?['inspect','cancel',...(Date.parse(row.expires_at)>Date.now()?['resume' as const]:[])]:['inspect','cancel','reconcile']
    return{stage_id:stageId,preview_id:row.preview_id,state,code:completed?null:row.safe_code as CsvApplyRunData['code'],command_id:commandId??row.cancellation_id??row.command_id,command_known:known,pending_command:pending,
      file_rows:tallies?.file_rows??0,selected_rows:tallies?.selected_rows??0,excluded_rows:(tallies?.file_rows??0)-(tallies?.selected_rows??0),committed_rows:counters?.committed_rows??0,inserted_rows:counters?.inserted_rows??0,already_imported_rows:counters?.already_imported_rows??0,created_setup:setup?.n??0,source_seconds_total:tallies?.source_seconds??null,source_seconds_committed:counters?.source_seconds_committed??0,destination_seconds:counters?.destination_seconds??0,destination_delta_seconds:(counters?.destination_seconds??0)-(counters?.source_seconds_committed??0),deleted_imported_rows:counters?.deleted_imported_rows??0,
      retention_deadline:row.finished_at?new Date(Math.min(Date.parse(row.expires_at),Date.parse(row.finished_at)+86400000)).toISOString():row.expires_at,retryable:['paused','partial'].includes(state)&&Date.parse(row.expires_at)>Date.now(),allowed_actions:actions}
  }
  const accept=async(authority:CsvStagingAuthority,stageId:string,packet:CsvApplyCommand,resume:boolean)=>{
    const row=await staging.owned(authority,stageId),intent=canonicalCsvApplyCommand(packet)
    const receipt=await database.prepare('SELECT request_json,actor_id FROM csv_worker_commands WHERE stage_id=? AND command_id=?').bind(stageId,packet.command_id).first<{request_json:string;actor_id:number}>()
    if(receipt){if(receipt.request_json!==intent.json||receipt.actor_id!==authority.userId)throw new CsvApplyRefusal('command_conflict');return status(authority,stageId,packet.command_id)}
    if(row.cancellation_id||row.status==='cancelled')throw new CsvApplyRefusal('cancelled')
    if(row.version!==packet.version||row.preview_id!==packet.preview_id)throw new CsvApplyRefusal('binding_mismatch')
    if(resume?!['paused','partial'].includes(row.status):row.status!=='previewed')throw new CsvApplyRefusal('apply_busy')
    const count=await database.prepare('SELECT count(*) AS n FROM csv_worker_commands WHERE stage_id=?').bind(stageId).first<{n:number}>();if((count?.n??0)>=100)throw new CsvApplyRefusal('command_limit_reached')
    const value=await staging.saved(authority,row,packet.preview_id),p=value.plan
    if(p.rejectedRows||p.plan.report.fileErrors.length||p.selectedRows!==packet.expected_selected_rows||p.sourceSeconds!==packet.expected_source_seconds||p.destinationSeconds!==packet.expected_destination_seconds||(p.excludedLines.length>0&&!packet.acknowledge_exclusions)||(p.destinationDeltaSeconds!==0&&!packet.acknowledge_destination_difference)||(p.plan.report.people.new>0&&!packet.acknowledge_new_people))throw new CsvApplyRefusal('binding_mismatch')
    const guard=csvStagingSessionFence(authority,row.target_nonce)
    await database.batch([
      database.prepare(`INSERT INTO csv_worker_fence(allowed) SELECT CASE WHEN EXISTS(SELECT 1 FROM csv_worker_stages WHERE id=? AND version=? AND revision=(SELECT revision FROM csv_worker_revision) AND cancellation_id IS NULL AND julianday(expires_at)>julianday('now')) AND (${guard.sql}) THEN 1 ELSE 0 END`).bind(row.id,row.version,...guard.params),
      database.prepare("INSERT INTO csv_worker_commands VALUES(?,?,?,?,?,?)").bind(stageId,packet.command_id,authority.userId,intent.json,resume?'resume':'apply',iso()),
      database.prepare("UPDATE csv_worker_stages SET status='queued',session_id=?,command_id=?,confirmation_id=coalesce(confirmation_id,?),command_json=?,attempts=0,budget_yields=0,next_attempt_at=NULL,lease_holder=NULL,lease_expires_at=NULL,safe_code=NULL,publish_pending=1,version=version+1 WHERE id=?").bind(authority.sessionRowId,packet.command_id,packet.command_id,intent.json,stageId),
      database.prepare('DELETE FROM csv_worker_fence'),
    ])
    return status(authority,stageId,packet.command_id)
  }
  const cancel:CsvImportApplyPort['cancel']=async(authority,stageId,command)=>{
    const row=await staging.owned(authority,stageId)
    if(!row.command_id)throw new CsvApplyRefusal('run_not_found')
    const native=row.native_run_id?await database.prepare('SELECT browser_state FROM csv_import_runs WHERE id=?').bind(row.native_run_id).first<{browser_state:string}>():null
    if(native?.browser_state==='complete')return status(authority,stageId)
    if(row.cancellation_id){if(row.cancellation_id!==command.command_id)throw new CsvApplyRefusal('command_conflict');return status(authority,stageId,command.command_id)}
    const guard=csvStagingSessionFence(authority,row.target_nonce)
    await database.batch([
      database.prepare(`INSERT INTO csv_worker_fence(allowed) SELECT CASE WHEN EXISTS(SELECT 1 FROM csv_worker_stages WHERE id=? AND version=? AND cancellation_id IS NULL) AND (${guard.sql}) THEN 1 ELSE 0 END`).bind(row.id,row.version,...guard.params),
      database.prepare("INSERT INTO csv_worker_commands VALUES(?,?,?,?, 'cancel',?)").bind(stageId,command.command_id,authority.userId,JSON.stringify(command),iso()),
      database.prepare("UPDATE csv_worker_stages SET status='cancelled',cancellation_id=?,finished_at=coalesce(finished_at,?),publish_pending=0,lease_holder=NULL,lease_expires_at=NULL,version=version+1 WHERE id=?").bind(command.command_id,iso(),stageId),
      database.prepare("UPDATE csv_import_runs SET browser_state='cancelled',status='aborted',finished_at=coalesce(finished_at,?),lease_holder=NULL,lease_expires_at=NULL WHERE id=? AND browser_state='partial'").bind(iso(),row.native_run_id),
      database.prepare('DELETE FROM csv_worker_fence'),
    ])
    return status(authority,stageId,command.command_id)
  }
  const settle=async(row:WorkerCsvStage,state:string,code:string|null,publish:boolean,attempts=row.attempts,delay=0)=>{
    if(code===null){
      try{const current=await staging.read(row.id);if(current?.lease_holder===row.lease_holder&&current.native_run_id&&current.object_key&&current.choices_key&&current.owner_id){
        const choices=await staging.json<import('@ezacto/api').CsvStagingChoices>(current,current.choices_key),body=new Uint8Array(await (await staging.object(current,current.object_key)).arrayBuffer())
        const fresh=await readD1CsvDestinationSnapshot(database,{kind:'administrator',userId:String(current.owner_id)},current.source_id!,body,{exporterZone:choices.exporter_zone,mapping:choices.mapping as unknown as import('../../../packages/migrate/src/csv-browser-mapping.js').CsvBrowserMapping,excludedLines:choices.excluded_lines})
        if(fresh.revision===current.revision)await database.prepare('UPDATE csv_worker_stages SET policy_hash=? WHERE id=? AND lease_holder=? AND revision=? AND revision=(SELECT revision FROM csv_worker_revision)').bind(fresh.policyHash,current.id,current.lease_holder,fresh.revision).run()
      }}catch{/* Failure to checkpoint never changes committed native progress. */}
    }

    await database.prepare(`UPDATE csv_worker_stages SET status=?,safe_code=?,attempts=?,next_attempt_at=?,publish_pending=?,lease_holder=NULL,lease_expires_at=NULL,finished_at=CASE WHEN ? IN('completed','cancelled','failed') THEN coalesce(finished_at,?) ELSE finished_at END,version=version+1 WHERE id=? AND lease_generation=? AND lease_holder=? AND cancellation_id IS NULL`).bind(state,code,attempts,delay?new Date(Date.now()+delay*1000).toISOString():null,publish?1:0,state,iso(),row.id,row.lease_generation,row.lease_holder).run()
  }
  const execute=async(stageId:string)=>{
    const budget=csvInvocationDatabase(database)
    const invocationDb=budget.database
    const localStaging=createWorkerCsvStaging(invocationDb,bucket,cursorKey)
    let row=await localStaging.read(stageId)
    if(!row||terminal.has(row.status)||row.status==='purged')return
    if(row.native_run_id){
      const native=await invocationDb.prepare('SELECT browser_state,source_id,finished_at FROM csv_import_runs WHERE id=?').bind(row.native_run_id).first<{browser_state:string;source_id:string;finished_at:string|null}>()
      if(native?.browser_state==='complete'&&native.source_id===row.source_id){await invocationDb.prepare("UPDATE csv_worker_stages SET status='completed',safe_code=NULL,finished_at=coalesce(finished_at,?),publish_pending=0,lease_holder=NULL,lease_expires_at=NULL,version=version+1 WHERE id=? AND version=? AND native_run_id=?").bind(native.finished_at??iso(),row.id,row.version,row.native_run_id).run();return}
    }
    if(row.status==='paused'||!row.owner_id||!row.session_id)return
    const authority={userId:row.owner_id,sessionRowId:row.session_id}
    try{await localStaging.authorize(authority,row.target_nonce)}catch{await invocationDb.prepare("UPDATE csv_worker_stages SET status='paused',safe_code='authority_revoked',publish_pending=0 WHERE id=? AND version=?").bind(stageId,row.version).run();return}
    if(Date.parse(row.expires_at)<=Date.now()){await invocationDb.prepare("UPDATE csv_worker_stages SET status='paused',safe_code='input_expired',publish_pending=0 WHERE id=? AND version=?").bind(stageId,row.version).run();return}
    if(row.revision!==await localStaging.revision()){await invocationDb.prepare("UPDATE csv_worker_stages SET status='paused',safe_code='policy_changed',publish_pending=0 WHERE id=? AND version=?").bind(stageId,row.version).run();return}
    const guard=csvStagingSessionFence(authority,row.target_nonce),holder=crypto.randomUUID()
    const claimed=await invocationDb.prepare(`UPDATE csv_worker_stages SET status='running',lease_generation=lease_generation+1,lease_holder=?,lease_expires_at=?,publish_pending=0,version=version+1 WHERE id=? AND version=? AND status IN('queued','partial','running') AND (lease_expires_at IS NULL OR julianday(lease_expires_at)<=julianday('now')) AND cancellation_id IS NULL AND revision=(SELECT revision FROM csv_worker_revision) AND (${guard.sql}) RETURNING *`).bind(holder,new Date(Date.now()+60000).toISOString(),stageId,row.version,...guard.params).first<WorkerCsvStage>()
    if(!claimed)return;row=claimed
    let nativeGeneration:number|undefined
    try{
      const input=await localStaging.saved(authority,row,row.preview_id??undefined)
      const service=await createD1CsvBrowserService(invocationDb,{stageId,targetNonce:row.target_nonce,authority,generation:row.lease_generation,holder})
      const actor={kind:'administrator' as const,userId:String(authority.userId)}
      if(!row.native_run_id){
        const sealed=await service.confirm(actor,input.plan)
        if(sealed.outcome==='blocked'){await settle(row,'paused','policy_changed',false);return}
        await invocationDb.prepare('UPDATE csv_worker_stages SET native_run_id=? WHERE id=? AND lease_generation=? AND lease_holder=?').bind(Number(sealed.run.runId),stageId,row.lease_generation,holder).run()
        await settle(row,sealed.run.status==='complete'?'completed':'queued',null,sealed.run.status!=='complete');return
      }
      const run={runId:String(row.native_run_id),planId:csvPlanId(csvBrowserSealInput(input.plan))}
      const prior=await service.ledger.getRun(actor,run.runId)
      if(prior?.status==='complete'){await settle(row,'completed',null,false);return}
      const lease=await service.ledger.claimLease(actor,{runId:run.runId,holder,ttlMs:60000})
      if(lease.outcome!=='claimed'){await settle(row,'queued',null,true,row.attempts,Math.ceil(lease.retryAfterMs/1000));return}
      nativeGeneration=lease.lease.generation
      // Claiming changes only lease metadata; prior progress remains authoritative
      // under the same stage revision, with every subsequent write fenced again.
      const current=prior
      if(!current||current.planId!==run.planId)throw new CsvApplyRefusal('binding_mismatch')
      const selected=input.plan.plan.items.filter(item=>item.state!=='rejected'),cursor=current.written+current.alreadyImported
      if(cursor<selected.length){
        const item=selected[cursor]!,targets=[item.person,item.project,item.project?.parent,item.task].filter((value):value is NonNullable<typeof value>=>value!==undefined&&value!==null)
        const receipts=(await invocationDb.prepare('SELECT setup_key,entity_kind,entity_id FROM csv_import_setup WHERE run_id=? AND setup_key IN(SELECT value FROM json_each(?))').bind(Number(run.runId),JSON.stringify(targets.map(target=>sha256Hex(target.key)))).all<{setup_key:string;entity_kind:string;entity_id:number}>()).results
        const createdIds=new Map<string,number>()
        for(const target of targets){const found=receipts.find(value=>value.setup_key===sha256Hex(target.key)&&value.entity_kind==={person:'users',client:'clients',project:'projects',task:'tasks'}[target.kind]);if(found)createdIds.set(target.key,found.entity_id)}
        const userId=item.person?.id??(item.person?createdIds.get(item.person.key):undefined),projectId=item.project?.id??(item.project?createdIds.get(item.project.key):undefined),taskId=item.task?.id??(item.task?createdIds.get(item.task.key):undefined)
        const pairs=projectId?await invocationDb.prepare(`SELECT 'user' AS kind,a.user_id AS left_id,a.project_id AS right_id FROM csv_import_setup s JOIN user_assignments a ON s.entity_kind='user-assignments' AND s.entity_id=a.id WHERE s.run_id=? AND a.user_id=? AND a.project_id=? UNION ALL SELECT 'task',a.project_id,a.task_id FROM csv_import_setup s JOIN task_assignments a ON s.entity_kind='task-assignments' AND s.entity_id=a.id WHERE s.run_id=? AND a.project_id=? AND a.task_id=?`).bind(Number(run.runId),userId??-1,projectId,Number(run.runId),projectId,taskId??-1).all<{kind:string;left_id:number;right_id:number}>():null
        const writer=service.writer(input.snapshot,input.plan,{createdIds,userPairs:(pairs?.results??[]).filter(pair=>pair.kind==='user').map(pair=>`${pair.left_id}:${pair.right_id}`),taskPairs:(pairs?.results??[]).filter(pair=>pair.kind==='task').map(pair=>`${pair.left_id}:${pair.right_id}`)})
        await writer.writeRow(actor,{runId:run.runId,...lease.lease},run.planId,item,cursor)
      }
      const finished=cursor+1>=selected.length
      if(finished){await service.ledger.finish(actor,{runId:run.runId,planId:run.planId,holder,leaseGeneration:lease.lease.generation,status:'complete'});await settle(row,'completed',null,false,0)}
      else{await service.database.prepare('UPDATE csv_import_runs SET lease_holder=NULL,lease_expires_at=NULL WHERE id=? AND lease_holder=? AND lease_generation=?').bind(Number(run.runId),holder,lease.lease.generation).run();await settle(row,'queued',null,true,0)}
    }catch(error){
      const current=await staging.read(stageId);
      if(error instanceof CsvInvocationBudget && current?.lease_holder===holder){
        if(current.native_run_id)await database.prepare('UPDATE csv_import_runs SET lease_holder=NULL,lease_expires_at=NULL WHERE id=? AND lease_holder=?').bind(current.native_run_id,holder).run()
        const progress=current.native_run_id?(await database.prepare('SELECT committed_chunks+(SELECT count(*) FROM csv_import_setup WHERE run_id=?) AS n FROM csv_import_runs WHERE id=?').bind(current.native_run_id,current.native_run_id).first<{n:number}>())?.n??0:0
        const yields=progress>current.budget_progress?0:current.budget_yields+1
        await database.prepare('UPDATE csv_worker_stages SET budget_yields=?,budget_progress=?,version=version+1 WHERE id=? AND lease_generation=? AND lease_holder=?').bind(yields,progress,current.id,current.lease_generation,holder).run()
        await settle(current,yields>=3?'paused':'queued',yields>=3?'processing_budget_exceeded':null,yields<3,current.attempts,1);return
      }if(!current||current.lease_holder!==holder||current.cancellation_id)return
      try{await staging.authorize(authority,current.target_nonce)}catch{await settle(current,'paused','authority_revoked',false);return}
      if(current.revision!==await staging.revision()){await settle(current,'paused','policy_changed',false);return}
      if(error instanceof CsvBrowserLedgerRefusal||error instanceof CsvBrowserPlannerError||error instanceof CsvApplyRefusal){await settle(current,'paused',error instanceof CsvBrowserPlannerError?'parse_rejected':'policy_changed',false);return}
      if(current.native_run_id&&nativeGeneration!==undefined)await database.prepare('UPDATE csv_import_runs SET lease_holder=NULL,lease_expires_at=NULL WHERE id=? AND lease_holder=? AND lease_generation=?').bind(current.native_run_id,holder,nativeGeneration).run()
      const attempts=Math.min(3,current.attempts+1);await settle(current,'partial','storage_unavailable',attempts<3,attempts,2**attempts)
      options.reportError?.(new Error('Private Worker CSV apply failed; inspect safe run status.'))
    }finally{options.onInvocation?.({calls:budget.calls(),phase:row.native_run_id?'row':'seal'})}
  }
  const port:CsvImportApplyPort={apply:(a,id,packet)=>accept(a,id,packet,false),resume:(a,id,packet)=>accept(a,id,packet,true),status,cancel}
  return{port,execute,staging}
}
