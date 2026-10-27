import { assertCutoverMigrationLedger } from '@ezacto/db/d1'
import { createWorkerCsvApply } from './csv-apply.js'
import { createWorkerCsvQueue, type CsvWorkerMessage } from './csv-queue.js'

export interface CsvMaintenanceMessage { kind:'csv-maintenance'; phase:'purge'|'publish' }
export interface CsvWorkerBindings {
  DB?:D1Database
  ATTACHMENTS?:R2Bucket
  CSV_IMPORT_QUEUE?:Queue<CsvWorkerMessage|CsvMaintenanceMessage>
  CSV_IMPORT_QUEUE_NAME?:string
}
// Refuse an unconfigured opt-in before resolving database/object bindings.
export const csvWorkerConfigured=(env:CsvWorkerBindings):boolean=>!!(env.CSV_IMPORT_QUEUE&&env.CSV_IMPORT_QUEUE_NAME&&/^[A-Za-z0-9_-]{1,63}$/.test(env.CSV_IMPORT_QUEUE_NAME)&&env.DB&&env.ATTACHMENTS)

/** Queue processing never performs DDL. The API/scheduler owns upgrades; an
 * old queued delivery waits for that barrier instead of exceeding its budget. */
export const verifyCsvQueueDatabase=async(database:D1Database):Promise<void>=>{
  const results=await database.batch([
    database.prepare('SELECT id,statements_sha256 FROM _ezacto_migrations'),
    database.prepare("SELECT 1 AS blocked WHERE EXISTS(SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1) OR EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))"),
  ])
  assertCutoverMigrationLedger(results[0]!.results as {id:string;statements_sha256:string|null}[])
  if(results[1]!.results.length)throw new Error('CSV queue waits for the existing privacy/migration quarantine.')
}

/** Explicit optional binding: existing deployments do not need a new queue. */
export const createCsvWorkerRuntime=(database:D1Database,bucket:R2Bucket,queue:Queue<CsvWorkerMessage|CsvMaintenanceMessage>,key:Uint8Array,reportError?:(error:Error)=>void)=>{
  const apply=createWorkerCsvApply(database,bucket,key,{...(reportError?{reportError}:{})})
  const transport=createWorkerCsvQueue({database,queue:queue as Queue<CsvWorkerMessage>,execute:apply.execute})
  const publish=async(id:string)=>{try{await transport.publish(id)}catch{reportError?.(new Error('CSV continuation publication deferred; durable pending pointer retained.'))}}
  return{
    staging:apply.staging.port,
    apply:{...apply.port,async apply(...args:Parameters<typeof apply.port.apply>){const result=await apply.port.apply(...args);await publish(args[1]);return result},async resume(...args:Parameters<typeof apply.port.resume>){const result=await apply.port.resume(...args);await publish(args[1]);return result}},
    async consume(batch:MessageBatch<unknown>){
      const [first,...rest]=batch.messages
      for(const message of rest)message.retry({delaySeconds:5})
      if(!first)return
      const body=first.body
      if(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===2&&'kind'in body&&body.kind==='csv-maintenance'&&'phase'in body&&(body.phase==='purge'||body.phase==='publish')){
        try{if(body.phase==='purge')await apply.staging.sweep();else await transport.repair();first.ack()}catch{first.retry({delaySeconds:30})}
        return
      }
      await transport.consume({...batch,messages:[first]})
    },
  }
}
