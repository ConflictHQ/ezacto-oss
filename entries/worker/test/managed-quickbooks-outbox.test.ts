import { describe,expect,it,vi } from 'vitest'
import type { QuickBooksRuntime } from '@ezacto/integrations'
import type { OutboxEventRecord,ManagedQuickBooksOutboxAdmission } from '@ezacto/db/d1'
import { createManagedQuickBooksOutboxSubscriber } from '../src/managed-quickbooks-outbox.js'
const at='2026-11-10T04:00:00.000Z'
const event:OutboxEventRecord={id:'owned',aggregateType:'invoice',aggregateId:1,aggregateSequence:1,eventType:'invoice.sent',payload:{},occurredAt:at,availableAt:at}
const current:ManagedQuickBooksOutboxAdmission={kind:'current',realmId:'111',generation:1,connectedAt:at}
const fixture=(grant:ManagedQuickBooksOutboxAdmission=current)=>{
  let enabled=true,authorization:'ready'|'pending'|'unavailable'='ready',writes:'ready'|'pending'|'unavailable'='ready'
  const mirror=vi.fn(async()=>({kind:'created',quickBooksId:'owned'})),mirrorPayment=vi.fn(async()=>({kind:'created',quickBooksId:'owned-payment'}))
  const runtime={mirror,mirrorPayment,service:{authorizationStatus:async()=>authorization,writeStatus:async()=>writes}} as unknown as QuickBooksRuntime
  const readAdmission=vi.fn(async()=>grant)
  const subscriber=createManagedQuickBooksOutboxSubscriber({runtime,available:()=>enabled,readAdmission})
  return {subscriber,mirror,mirrorPayment,readAdmission,pause:()=>{enabled=false},authorization:(value:typeof authorization)=>{authorization=value},writes:(value:typeof writes)=>{writes=value}}
}
describe('managed QuickBooks outbox admission',()=>{
  it('retains an accepted grant while unavailable and fences a change after preclaim',async()=>{
    const f=fixture();expect(await f.subscriber.available!(event)).toBe(true)
    f.pause();expect(await f.subscriber.available!(event)).toBe(false)
    await expect(f.subscriber.deliver(event,{} as never)).rejects.toMatchObject({code:'provider_unavailable'})
    expect(f.mirror).not.toHaveBeenCalled()
    const absentRuntime=createManagedQuickBooksOutboxSubscriber({runtime:null,available:()=>true,readAdmission:async()=>current})
    expect(await absentRuntime.available!(event)).toBe(false)
  })
  it.each(['pending','unavailable'] as const)('retains token authorization %s before claiming',async state=>{
    const f=fixture();f.authorization(state);expect(await f.subscriber.available!(event)).toBe(false);expect(f.mirror).not.toHaveBeenCalled()
  })
  it('permits safe unknown-write recovery while holding custody that requires review',async()=>{
    const f=fixture();f.writes('pending');expect(await f.subscriber.available!(event)).toBe(true)
    await f.subscriber.deliver(event,{} as never);expect(f.mirror).toHaveBeenCalledWith(1)
    f.writes('unavailable');expect(await f.subscriber.available!(event)).toBe(false)
  })
  it('does not send a delayed event into a newly accepted company/grant',async()=>{
    const f=fixture({kind:'stale'})
    expect(await f.subscriber.available!(event)).toBe(true);await f.subscriber.deliver(event,{} as never)
    expect(f.mirror).not.toHaveBeenCalled()
  })
  it('does not hold unrelated events or QuickBooks payment echoes during a pause',async()=>{
    const f=fixture();f.pause()
    for(const ignored of [{...event,eventType:'invoice.updated'},{...event,aggregateType:'project'},
      {...event,eventType:'payment.recorded',payload:{payment:{after:{id:1,amount_cents:100,provider:'quickbooks',paid_date:'2026-11-10'}}}}]){
      expect(await f.subscriber.available!(ignored)).toBe(true);await f.subscriber.deliver(ignored,{} as never)
    }
    expect(f.readAdmission).not.toHaveBeenCalled();expect(f.mirror).not.toHaveBeenCalled();expect(f.mirrorPayment).not.toHaveBeenCalled()
  })
  it('acknowledges events with no live accepted grant without guessing credentials',async()=>{
    const f=fixture({kind:'absent'});expect(await f.subscriber.available!(event)).toBe(true)
    await f.subscriber.deliver(event,{} as never);expect(f.mirror).not.toHaveBeenCalled()
    const legacy=fixture({kind:'unavailable'});expect(await legacy.subscriber.available!(event)).toBe(false)
  })
})
