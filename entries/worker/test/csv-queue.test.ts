import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkerCsvQueue, type CsvWorkerMessage } from '../src/csv-queue.js'

const stage = (n: number) => `csv_${n.toString(16).padStart(32, '0')}`
const future = '2099-01-01T00:00:00.000Z'
const schema = `CREATE TABLE csv_worker_stages(id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL,expires_at TEXT NOT NULL,publish_pending INTEGER NOT NULL DEFAULT 1,next_attempt_at TEXT,lease_expires_at TEXT,steps INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE fixture_effects(stage_id TEXT NOT NULL,step INTEGER NOT NULL,PRIMARY KEY(stage_id,step)) STRICT;
CREATE TABLE fixture_deliveries(body TEXT NOT NULL,attempt INTEGER NOT NULL) STRICT;`
let mf: Miniflare | undefined
afterEach(async () => { await mf?.dispose(); mf = undefined })
const database = async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] })
  const db = await mf.getD1Database('DB'); await db.exec(schema); return db
}
type Send = (message: CsvWorkerMessage, options?: { delaySeconds?: number }) => Promise<void>
const producer = (send: Send) => ({ send }) as unknown as Queue<CsvWorkerMessage>

describe('CSV continuation publication', () => {
  it('retains a committed outbox on lost send and fences a newer continuation version', async () => {
    const db = await database(), id = stage(1)
    await db.prepare('INSERT INTO csv_worker_stages(id,status,expires_at) VALUES(?,?,?)').bind(id, 'queued', future).run()
    const send = vi.fn<Send>(async () => { throw new Error('acknowledgement lost') })
    const adapter = createWorkerCsvQueue({ database: db as unknown as D1Database, queue: producer(send), execute: async () => {} })
    await expect(adapter.publish(id)).rejects.toThrow('acknowledgement lost')
    expect(await db.prepare('SELECT publish_pending FROM csv_worker_stages WHERE id=?').bind(id).first('publish_pending')).toBe(1)
    send.mockImplementationOnce(async () => { await db.prepare('UPDATE csv_worker_stages SET version=version+1 WHERE id=?').bind(id).run() })
    await adapter.publish(id)
    expect(await db.prepare('SELECT publish_pending FROM csv_worker_stages WHERE id=?').bind(id).first('publish_pending')).toBe(1)
    send.mockResolvedValueOnce(undefined)
    await adapter.repair()
    expect(await db.prepare('SELECT publish_pending FROM csv_worker_stages WHERE id=?').bind(id).first('publish_pending')).toBe(0)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[0]).toEqual([{ kind: 'csv-import', stage_id: id }, { delaySeconds: 0 }])
  })

  it('recovers expired running leases, skips terminal/expired stages, bounds repairs and delays future continuations', async () => {
    const db = await database(), sent: CsvWorkerMessage[] = []
    for (let n = 1; n <= 12; n++) await db.prepare('INSERT INTO csv_worker_stages(id,status,expires_at,publish_pending,lease_expires_at) VALUES(?,?,?,?,?)').bind(stage(n), n === 1 ? 'running' : 'queued', future, n === 1 ? 0 : 1, n === 1 ? '2000-01-01T00:00:00.000Z' : null).run()
    for (const [n, state, expiry] of [[20, 'cancelled', future], [21, 'paused', future], [22, 'queued', '2000-01-01T00:00:00.000Z']] as const) await db.prepare('INSERT INTO csv_worker_stages(id,status,expires_at) VALUES(?,?,?)').bind(stage(n), state, expiry).run()
    const queue = producer(async body => { sent.push(body) })
    const adapter = createWorkerCsvQueue({ database: db as unknown as D1Database, queue, execute: async () => {} })
    await adapter.repair()
    expect(sent).toHaveLength(10)
    expect(sent.every(body => Number.parseInt(body.stage_id.slice(4), 16) <= 12)).toBe(true)
    expect(await db.prepare('SELECT version,publish_pending FROM csv_worker_stages WHERE id=?').bind(stage(1)).first()).toMatchObject({ version: 2, publish_pending: 0 })
    await db.prepare('UPDATE csv_worker_stages SET next_attempt_at=?,publish_pending=1 WHERE id=?').bind(new Date(Date.now() + 60_000).toISOString(), stage(12)).run()
    const delay = vi.fn<Send>(async () => {})
    await createWorkerCsvQueue({ database: db as unknown as D1Database, queue: producer(delay), execute: async () => {} }).publish(stage(12))
    expect(delay.mock.calls[0]![1]).toMatchObject({ delaySeconds: expect.any(Number) })
    expect(delay.mock.calls[0]![1]!.delaySeconds).toBeGreaterThanOrEqual(59)
    expect(delay.mock.calls[0]![1]!.delaySeconds).toBeLessThanOrEqual(60)
  })

  it('acks malformed pointers and cancelled work without execution; retries transient failures with bounded delay', async () => {
    const db = await database(), id = stage(1)
    await db.prepare('INSERT INTO csv_worker_stages(id,status,expires_at,publish_pending) VALUES(?,?,?,0)').bind(id, 'queued', future).run()
    const execute = vi.fn(async () => { throw new Error('worker stopped') })
    const adapter = createWorkerCsvQueue({ database: db as unknown as D1Database, queue: producer(async () => {}), execute })
    const ack = vi.fn(), retry = vi.fn()
    const message = (body: unknown, attempts = 1) => ({ body, attempts, ack, retry }) as unknown as Message<unknown>
    await adapter.consume({ messages: [message({ kind: 'csv-import', stage_id: id, authority: 'forged' }), message({ kind: 'csv-import', stage_id: '../private' }), message({ kind: 'csv-import', stage_id: id }, 20)] } as unknown as MessageBatch<unknown>)
    expect(ack).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledOnce(); expect(retry).toHaveBeenCalledWith({ delaySeconds: 300 })
    await db.prepare("UPDATE csv_worker_stages SET status='cancelled' WHERE id=?").bind(id).run()
    await adapter.consume({ messages: [message({ kind: 'csv-import', stage_id: id })] } as unknown as MessageBatch<unknown>)
    expect(execute).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledTimes(3)
  })
})

it('[native transport] recovers lost publication and acknowledgement with real D1, private R2 and Queue delivery', async () => {
  const bundle = await build({
    stdin: { resolveDir: new URL('../', import.meta.url).pathname, contents: `
      import {createWorkerCsvQueue} from './src/csv-queue.ts'
      const transport=(env,fail=false)=>createWorkerCsvQueue({database:env.DB,queue:{send:async(body,options)=>{if(fail)throw new Error('lost send');return env.QUEUE.send(body,options)}},execute:async(id)=>{
        const object=await env.RAW.get('fixture/'+id);if(!object)throw new Error('missing private object');const source=await object.json();
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO fixture_effects(stage_id,step) SELECT id,steps+1 FROM csv_worker_stages WHERE id=? AND status IN ('queued','partial')").bind(id),
          env.DB.prepare("UPDATE csv_worker_stages SET steps=steps+1,version=version+1,status=CASE WHEN steps+1>=? THEN 'completed' ELSE 'partial' END,publish_pending=CASE WHEN steps+1>=? THEN 0 ELSE 1 END WHERE id=? AND status IN ('queued','partial')").bind(source.steps,source.steps,id)
        ])
      }})
      export default {
        async fetch(request,env){const url=new URL(request.url);const id=url.searchParams.get('id');try{
          if(url.pathname==='/publish')await transport(env,url.searchParams.has('fail')).publish(id);
          if(url.pathname==='/repair')await transport(env).repair();
          if(url.pathname==='/duplicate')await env.QUEUE.send({kind:'csv-import',stage_id:id});
          if(url.pathname==='/malformed')await env.QUEUE.send({kind:'csv-import',stage_id:id,authority:'forged'});
          return new Response(null,{status:204})
        }catch{return new Response(null,{status:503})}},
        async queue(batch,env){
          for(const message of batch.messages)await env.DB.prepare('INSERT INTO fixture_deliveries(body,attempt) VALUES(?,?)').bind(JSON.stringify(message.body),message.attempts).run();
          const messages=batch.messages.map(message=>({body:message.body,attempts:message.attempts,ack:()=>{if(message.attempts===1)message.retry({delaySeconds:0});else message.ack()},retry:()=>message.retry({delaySeconds:0})}));
          await transport(env).consume({...batch,messages})
        }
      }` },
    bundle: true, platform: 'browser', conditions: ['development'], format: 'esm', target: 'es2022', write: false,
  })
  mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-06', d1Databases: ['DB'], r2Buckets: ['RAW'], queueProducers: { QUEUE: 'csv-fixture' }, queueConsumers: { 'csv-fixture': { maxBatchSize: 1, maxBatchTimeout: 0, retryDelay: 0 } } })
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('RAW'), id = stage(1)
  await db.exec(schema); await bucket.put('fixture/' + id, JSON.stringify({ steps: 2 }))
  await db.prepare('INSERT INTO csv_worker_stages(id,status,expires_at) VALUES(?,?,?)').bind(id, 'queued', future).run()
  expect((await mf.dispatchFetch('https://fixture.test/publish?id=' + id + '&fail=1')).status).toBe(503)
  expect(await db.prepare('SELECT publish_pending FROM csv_worker_stages WHERE id=?').bind(id).first('publish_pending')).toBe(1)
  expect((await mf.dispatchFetch('https://fixture.test/repair')).status).toBe(204)
  await expect.poll(() => db.prepare('SELECT status FROM csv_worker_stages WHERE id=?').bind(id).first('status')).toBe('completed')
  await mf.dispatchFetch('https://fixture.test/duplicate?id=' + id)
  await mf.dispatchFetch('https://fixture.test/malformed?id=' + id)
  await expect.poll(() => db.prepare('SELECT count(*) n FROM fixture_deliveries').first('n')).toBeGreaterThanOrEqual(6)
  expect(await db.prepare('SELECT count(*) n FROM fixture_effects').first('n')).toBe(2)
  const deliveries = await db.prepare('SELECT body,attempt FROM fixture_deliveries').all<{ body: string; attempt: number }>()
  expect(deliveries.results.some(row => row.attempt > 1)).toBe(true)
  expect(deliveries.results.filter(row => !JSON.parse(row.body).authority).every(row => Object.keys(JSON.parse(row.body)).sort().join(',') === 'kind,stage_id')).toBe(true)
  expect(await bucket.get('fixture/' + id)).not.toBeNull()
}, 30_000)
