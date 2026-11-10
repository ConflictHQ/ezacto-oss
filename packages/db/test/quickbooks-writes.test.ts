import BetterSqlite3 from 'better-sqlite3'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createManagedQuickBooksWrites, quickBooksWriteSourceHash, type QuickBooksWriteTransport, type ManagedQuickBooksWriteStore } from '@ezacto/integrations'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { atomicStatements } from '../src/atomic-statements.js'
import { recordInvoicePayment, executeInvoiceEdit } from '../src/invoice-state.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import { createManagedQuickBooksGrantStore } from '../src/managed-quickbooks.js'
import { createManagedQuickBooksLifecycleStore } from '../src/managed-quickbooks-lifecycle.js'
import { createQuickBooksStore } from '../src/quickbooks.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createManagedQuickBooksWriteStore } from '../src/quickbooks-writes.js'

const at = '2026-11-10T04:00:00.000Z'
const grantId = 'a'.repeat(64), authority = { kind: 'guarded-session', userId: 2 } as const
const worker = { modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] } as const
const result = { Invoice: { Id: 'qb-one', SyncToken: '0' } }

describe.each(['sqlite','d1'] as const)('native managed QuickBooks accounting writes %s', backend => {
  let root: string, snapshot: Buffer
  const closers: (() => Promise<void>)[] = []
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(),'qb-write-'))
    if (backend === 'sqlite') {
      const native = new BetterSqlite3(':memory:')
      try { migrateContainer(native); snapshot = native.serialize() } finally { native.close() }
    } else {
      const template = new Miniflare({ ...worker,d1Persist:join(root,'template') })
      let closing: Promise<void> | undefined
      const close = () => closing ??= template.dispose(); closers.push(close)
      try { await migrateD1(await template.getD1Database('DB')) } finally { await close() }
    }
  })
  afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })
  afterAll(async () => { await Promise.all(closers.splice(0).map(close => close())); if (root) await rm(root,{recursive:true,force:true}) })
  const fixture = async () => {
    let db: InvoiceStateDatabase
    if (backend === 'sqlite') {
      const native = new BetterSqlite3(Buffer.from(snapshot));native.pragma('foreign_keys=ON')
      closers.push(async () => { native.close() });db=createContainerDatabase(native)
    } else {
      const path=join(root,crypto.randomUUID());await cp(join(root,'template'),path,{recursive:true})
      const mf=new Miniflare({...worker,d1Persist:path});let closing:Promise<void>|undefined
      closers.push(() => closing ??= mf.dispose());db=createD1Database(await mf.getD1Database('DB'))
    }
    const execute=async(text:string,params:readonly unknown[]=[]) => (await atomicStatements(db,[{text: /^(INSERT|UPDATE|DELETE)/i.test(text) ? text+' RETURNING *' : text,params}]))[0]!
    await execute(`INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned','{}',?,?)`,[at,at])
    await execute(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)
      VALUES(1,'Owner','Fixture','administrator','[]',?,?),(2,'Admin','Fixture','administrator','[]',?,?)`,[at,at,at,at])
    await execute(`INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Customer','USD',?,?)`,[at,at])
    await execute(`INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,state,amount_cents,due_amount_cents,created_at,updated_at)
      VALUES(1,1,'Owned-1','USD','2026-11-10','2026-11-30','open',100,100,?,?)`,[at,at])
    await executeInvoiceEdit(db,{invoiceId:1,commandId:'owned-fixture-line',actor:{type:'user',id:2},expectedVersion:0,occurredAt:at,
      authorize:async()=>true,eventIds:['owned-fixture-line-event'],edit:{type:'line_insert',lineId:1,position:0,kind:'Service',description:'Owned work',quantity:1,unitPriceCents:100,amountCents:100}})
    await createManagedQuickBooksGrantStore(db).accept({grantId,browserHash:'b'.repeat(64),credentialHash:'c'.repeat(64),expectedActorUserId:2,
      expectedConnectionGeneration:0,expiresAt:Date.parse(at)+600000,tokens:{realmId:'111',companyName:'Owned',accessToken:'OWNED_ACCESS',refreshToken:'OWNED_REFRESH',
      accessTokenExpiresAt:'2026-11-11T04:00:00.000Z',refreshTokenExpiresAt:'2027-01-01T00:00:00.000Z',scope:'com.intuit.quickbooks.accounting'}},authority,at)
    const connection=(await createQuickBooksStore(db).readConnection())!
    const store=createManagedQuickBooksWriteStore(db)
    let now=new Date(at)
    const compose=(override?:ManagedQuickBooksWriteStore) => createManagedQuickBooksWrites({store:override ?? createManagedQuickBooksWriteStore(db),admitted:()=>true,now:()=>now}).session(connection)
    const source={resource:'invoice' as const,nativeId:1,invoiceId:1,invoiceVersion:1,sourceHash:await quickBooksWriteSourceHash({number:'Owned-1',amountCents:100})}
    const intent={...source,operation:'create' as const},request={path:'/invoice' as const,minorVersion:'75',body:JSON.stringify({DocNumber:'Owned-1',TotalAmt:1})}
    return {db,execute,connection,store,compose,source,intent,request,advance:()=>{now=new Date(now.getTime()+60000)},
      lifecycle:createManagedQuickBooksLifecycleStore(db)}
  }
  it('commits exact intent before POST and gives competing runtimes only one transport owner',async()=>{
    const f=await fixture(), before=await f.execute('SELECT * FROM invoices')
    let enter!:()=>void,release!:()=>void,calls=0
    const started=new Promise<void>(resolve=>{enter=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
    const send:QuickBooksWriteTransport=async input=>{calls++;expect(input.body).toBe(f.request.body);enter();await wait;return result}
    const first=f.compose().execute(f.intent,f.request,send);await started
    await expect(f.compose().execute(f.intent,f.request,send)).rejects.toMatchObject({code:'provider_unavailable'})
    expect(calls).toBe(1);release();await expect(first).resolves.toEqual(result)
    expect(await f.store.status()).toBe('ready')
    expect(await f.execute('SELECT * FROM invoices')).toEqual(before)
    expect(await f.compose().knownCreatedLink('invoice',1)).toEqual({quickBooksId:'qb-one',syncToken:'0'})
    await expect(f.compose().execute({...f.intent,sourceHash:'f'.repeat(64)},{...f.request,body:'{"DocNumber":"renamed"}'},send)).rejects.toMatchObject({code:'provider_unavailable'})
    expect(calls).toBe(1)
  })
  it('recovers a lost response after restart with the same request ID and exact body, refusing changed actuals',async()=>{
    const f=await fixture(),sent:unknown[]=[]
    const lost:QuickBooksWriteTransport=async input=>{sent.push(input);throw new Error('owned lost reply')}
    await expect(f.compose().execute(f.intent,f.request,lost)).rejects.toMatchObject({code:'provider_unavailable'})
    expect(await f.store.status()).toBe('pending')
    await expect(createManagedQuickBooksGrantStore(f.db).prepare(authority,at)).rejects.toMatchObject({kind:'conflict'})
    await expect(f.compose().recover({...f.source,sourceHash:'d'.repeat(64)},lost)).rejects.toMatchObject({code:'provider_unavailable'})
    expect(sent).toHaveLength(1)
    const replay:QuickBooksWriteTransport=async input=>{sent.push(input);return result}
    await f.compose().recover(f.source,replay)
    expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
    await f.compose().recover(f.source,replay);expect(sent).toHaveLength(2)
    expect(await f.store.pendingWrites({connection:f.connection,limit:10,now:at})).toEqual([])
  })
  it('fences transport on native invoice version and refuses an aliased grant generation',async()=>{
    const f=await fixture(),ownerId=crypto.randomUUID(),effectId=crypto.randomUUID()
    const command={connection:f.connection,intent:f.intent,request:f.request,effectId,ownerId,now:at,leaseUntil:'2026-11-10T04:00:30.000Z'}
    expect(await f.store.prepare({...command,connection:{...f.connection,connectionGeneration:0}})).toEqual({kind:'unavailable'})
    expect(await f.execute('SELECT id FROM quickbooks_write_effects')).toEqual([])
    expect(await f.store.prepare(command)).toMatchObject({kind:'owned'})
    await recordInvoicePayment(f.db,{invoiceId:1,commandId:'advance-native-version',actor:{type:'user',id:2},expectedVersion:1,occurredAt:at,
      eventIds:['advance-payment','advance-paid'],authorize:async()=>true,payment:{type:'manual',id:1,currency:'USD',amountCents:1,paidAt:null,paidDate:'2026-11-10'}})
    expect(await f.store.begin({effectId,ownerId,now:at})).toBe(false)
    await f.store.releaseBeforeTransport({ownerId,now:at})
    expect(await f.store.status()).toBe('ready')
  })
  it('keeps late provider results after a lifecycle fence without adopting them into a replacement grant',async()=>{
    const f=await fixture()
    await expect(f.compose().execute(f.intent,f.request,async()=>{
      await f.lifecycle.fence({revocationId:'d'.repeat(64),grantId,expectedActorUserId:2,expectedConnectionGeneration:1,environment:'sandbox',reason:'disconnect'},authority,at)
      return result
    })).rejects.toMatchObject({code:'provider_unavailable'})
    expect(await f.execute('SELECT state FROM quickbooks_write_effects')).toEqual([{state:'orphaned'}])
    expect(await f.execute('SELECT state,provider_id FROM quickbooks_write_attempts')).toEqual([{state:'observed',provider_id:'qb-one'}])
    expect(await f.store.status()).toBe('unavailable')
  })
  it('cancels only proven unsent ownership when command acknowledgements are lost',async()=>{
    for (const stage of ['prepare-before','prepare-after','begin-after'] as const) {
      const f=await fixture();let calls=0
      const transport:QuickBooksWriteTransport=async()=>{calls++;return result}
      const lost:ManagedQuickBooksWriteStore={...f.store,
        prepare:async input=>{
          if (stage==='prepare-before') throw new Error('owned before-commit lost acknowledgement')
          const plan=await f.store.prepare(input)
          if (stage==='prepare-after') throw new Error('owned after-commit lost acknowledgement')
          return plan
        },
        begin:async input=>{const begun=await f.store.begin(input);if(stage==='begin-after')throw new Error('owned begin acknowledgement lost');return begun},
      }
      await expect(f.compose(lost).execute(f.intent,f.request,transport)).rejects.toMatchObject({code:'provider_unavailable'})
      expect(calls).toBe(0)
      const rows=await f.execute('SELECT state FROM quickbooks_write_effects')
      expect(rows).toEqual(stage==='prepare-before'?[]:[{state:'cancelled'}])
      if(stage==='begin-after')expect(await f.execute('SELECT state FROM quickbooks_write_attempts')).toEqual([{state:'cancelled_unsent'}])
      await expect(f.compose().execute(f.intent,f.request,transport)).resolves.toEqual(result)
      expect(calls).toBe(1)
    }
  })
  it('keeps an earlier unknown effect when a later proven-unsent recovery loses its begin acknowledgement',async()=>{
    const f=await fixture(),sent:string[]=[]
    await expect(f.compose().execute(f.intent,f.request,async input=>{sent.push(input.requestId);throw new Error('owned lost provider reply')})).rejects.toMatchObject({code:'provider_unavailable'})
    const lost:ManagedQuickBooksWriteStore={...f.store,begin:async input=>{await f.store.begin(input);throw new Error('owned recovery begin acknowledgement lost')}}
    await expect(f.compose(lost).execute(f.intent,f.request,async input=>{sent.push(input.requestId);return result})).rejects.toMatchObject({code:'provider_unavailable'})
    expect(sent).toHaveLength(1)
    expect(await f.execute('SELECT state FROM quickbooks_write_effects')).toEqual([{state:'unknown'}])
    expect(await f.execute('SELECT state FROM quickbooks_write_attempts ORDER BY state')).toEqual([{state:'cancelled_unsent'},{state:'unknown'}])
    await f.compose().recover(f.source,async input=>{sent.push(input.requestId);return result})
    expect(sent).toHaveLength(2);expect(sent[1]).toBe(sent[0])
  })
  it('retains both observations if an expired owner returns an inconsistent provider identity',async()=>{
    const f=await fixture();let entered!:()=>void,release!:(value:Record<string,unknown>)=>void
    const started=new Promise<void>(resolve=>{entered=resolve}),held=new Promise<Record<string,unknown>>(resolve=>{release=resolve})
    const sent:string[]=[]
    const first=f.compose().execute(f.intent,f.request,async input=>{sent.push(input.requestId);entered();return held})
    await started;f.advance()
    await f.compose().recover(f.source,async input=>{sent.push(input.requestId);return result})
    expect(sent).toHaveLength(2);expect(sent[0]).toBe(sent[1])
    release({Invoice:{Id:'unexpected-second-id',SyncToken:'0'}})
    await expect(first).rejects.toMatchObject({code:'provider_unavailable'})
    expect(await f.execute('SELECT state FROM quickbooks_write_effects')).toEqual([{state:'conflicted'}])
    expect(await f.execute("SELECT provider_id FROM quickbooks_write_attempts WHERE state='observed' ORDER BY provider_id")).toEqual([{provider_id:'qb-one'},{provider_id:'unexpected-second-id'}])
  })
  it('uses the retained completed create when native link persistence loses its acknowledgement',async()=>{
    const f=await fixture();let calls=0
    const transport:QuickBooksWriteTransport=async()=>{calls++;return result}
    const lost:ManagedQuickBooksWriteStore={...f.store,complete:async input=>{await f.store.complete(input);throw new Error('owned result acknowledgement lost')}}
    await expect(f.compose(lost).execute(f.intent,f.request,transport)).rejects.toMatchObject({code:'provider_unavailable'})
    expect(await f.compose().knownCreatedLink('invoice',1)).toEqual({quickBooksId:'qb-one',syncToken:'0'})
    await f.compose().recover(f.source,transport)
    await expect(f.compose().execute(f.intent,f.request,transport)).resolves.toEqual(result)
    expect(calls).toBe(1)
  })
  it('rotates bounded recovery selection so one refused entity does not starve the others',async()=>{
    const f=await fixture()
    const lost:QuickBooksWriteTransport=async()=>{throw new Error('owned lost provider reply')}
    await expect(f.compose().execute(f.intent,f.request,lost)).rejects.toMatchObject({code:'provider_unavailable'})
    await expect(f.compose().execute({...f.intent,resource:'customer',sourceHash:'c'.repeat(64)},
      {...f.request,path:'/customer',body:'{"DisplayName":"Owned Customer"}'},lost)).rejects.toMatchObject({code:'provider_unavailable'})
    const first=await f.store.pendingWrites({connection:f.connection,limit:1,now:'2026-11-10T04:01:00.000Z'})
    const second=await f.store.pendingWrites({connection:f.connection,limit:1,now:'2026-11-10T04:02:00.000Z'})
    expect(first).toHaveLength(1);expect(second).toHaveLength(1);expect(first[0]!.resource).not.toBe(second[0]!.resource)
    expect(await f.execute('SELECT state FROM quickbooks_write_effects ORDER BY resource')).toEqual([{state:'unknown'},{state:'unknown'}])
  })
  it('includes unresolved accounting custody in account closure inventory without exposing financial payloads',async()=>{
    const f=await fixture()
    await expect(f.compose().execute(f.intent,f.request,async()=>{throw new Error('owned lost reply')})).rejects.toMatchObject({code:'provider_unavailable'})
    await createAccountRetentionRepository(f.db).publish({actorUserId:1,expectedVersion:0,now:at,
      policy:{frameworks:[],retained_records:(['audit_and_security','billing_and_payments'] as const).map(category=>({category,reason:'Owned fixture review.',period:'One year then review.',review_after_days:30})),
        response_target_days:14,operator_contact:'privacy@example.test',user_notice:'Reviewed closure.',backup_handling:'Replay closure.',acknowledged:true}})
    await createAccountDeletionRequestRepository(f.db).request({userId:2,id:'owned-write-closure',now:at,expectedPolicyVersion:1})
    const preview=await createAccountClosureRepository(f.db).preview(1,'owned-write-closure')
    expect(preview.inventory).toContainEqual({location:'quickbooks_write_effects.actor_id',count:1,category:'billing_and_payments'})
    expect(JSON.stringify(preview)).not.toContain('Owned-1')
    expect(await f.execute('SELECT state FROM quickbooks_write_effects')).toEqual([{state:'unknown'}])
  })
  it('preserves multibyte payloads across native chunk boundaries and verifies immutable custody',async()=>{
    const f=await fixture(),body=JSON.stringify({DocNumber:'Owned-1',PrivateNote:'é😀'.repeat(30000)})
    let exact=''
    await f.compose().execute(f.intent,{...f.request,body},async input=>{exact=input.body;return {...result,time:'response😀'.repeat(20000)}})
    expect(exact).toBe(body)
    expect((await f.execute('SELECT count(*) AS n FROM quickbooks_write_request_chunks'))[0]!.n).toBeGreaterThan(1)
    await expect(f.execute("UPDATE quickbooks_write_request_chunks SET data='e30=' WHERE position=0")).rejects.toThrow('managed_quickbooks_write_chunk_immutable')
    await expect(f.execute('DELETE FROM quickbooks_write_effects')).rejects.toThrow('managed_quickbooks_write_intent_retained')
  })
})
