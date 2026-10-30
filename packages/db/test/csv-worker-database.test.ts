import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { migrateD1 } from '../src/migrate.js'
import { createD1SessionStore } from '../src/sessions.js'
import { csvWorkerDatabase } from '../src/csv-worker-database.js'
const fixtures: Miniflare[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())) })
const owned = async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch(){return new Response("ok")} }', d1Databases: ['DB'] })
  fixtures.push(mf)
  const db = await mf.getD1Database('DB'), now = new Date().toISOString()
  await migrateD1(db)
  await db.prepare("INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned D1 CSV','{}',?,?)").bind(now,now).run()
  await db.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Owned','Administrator','administrator','[]',?,?)").bind(now,now).run()
  const session = await createD1SessionStore(db).issue(2)
  const nonce = (await db.prepare('SELECT nonce FROM csv_staging_instance').first<{nonce:string}>())!.nonce
  await db.prepare(`INSERT INTO csv_worker_stages(id,target_nonce,owner_id,status,file_sha256,file_bytes,revision,session_id,lease_generation,lease_holder,lease_expires_at,created_at,expires_at)
    SELECT 'csv_owned',?,2,'running',?,1,revision,?,1,'owned-holder',?,?,? FROM csv_worker_revision`).bind(nonce,'a'.repeat(64),session.session.id,new Date(Date.now()+60000).toISOString(),now,new Date(Date.now()+3600000).toISOString()).run()
  const wrapped = csvWorkerDatabase(db,{stageId:'csv_owned',targetNonce:nonce,authority:{userId:2,sessionRowId:session.session.id},generation:1,holder:'owned-holder'})
  const insert = (name:string) => wrapped.prepare('INSERT INTO clients(name,currency,created_at,updated_at) VALUES(?,?,?,?) RETURNING id').bind(name,'USD',now,now)
  return { db, wrapped, insert, session, now }
}
it('uses a real atomic D1 batch and acknowledges only its own committed revision',async()=>{
  const f=await owned()
  await f.wrapped.batch([f.insert('First')])
  const after=await f.db.prepare('SELECT s.revision AS staged,r.revision AS current FROM csv_worker_stages s,csv_worker_revision r').first()
  expect(after).toMatchObject({staged: expect.any(Number), current: expect.any(Number)})
  expect((after as {staged:number}).staged).toBe((after as {current:number}).current)
  await f.wrapped.batch([f.insert('Second')])
  expect(await f.db.prepare('SELECT count(*) AS n FROM clients').first()).toEqual({n:2})
  const before=await f.db.prepare('SELECT revision FROM csv_worker_revision').first()
  await expect(f.wrapped.batch([f.insert('Rolled back'),f.wrapped.prepare("INSERT INTO organizations(id,name) VALUES(1,'duplicate')")])).rejects.toThrow()
  expect(await f.db.prepare('SELECT count(*) AS n FROM clients').first()).toEqual({n:2})
  expect(await f.db.prepare('SELECT revision FROM csv_worker_revision').first()).toEqual(before)
  expect(await f.db.prepare('SELECT count(*) AS n FROM csv_worker_fence').first()).toEqual({n:0})
})
it('refuses changed destination facts without rolling back normal organization changes',async()=>{
  const f=await owned()
  await f.db.prepare("UPDATE organizations SET currency='EUR' WHERE id=1").run()
  await expect(f.wrapped.batch([f.insert('Refused')])).rejects.toThrow()
  expect(await f.db.prepare('SELECT currency FROM organizations').first()).toEqual({currency:'EUR'})
  expect(await f.db.prepare('SELECT count(*) AS n FROM clients').first()).toEqual({n:0})
})
it('fences replaced leases and revoked sessions even when the object remains readable',async()=>{
  const f=await owned()
  await f.db.prepare('UPDATE csv_worker_stages SET lease_generation=2').run()
  await expect(f.wrapped.batch([f.insert('Old lease')])).rejects.toThrow()
  await f.db.prepare('UPDATE csv_worker_stages SET lease_generation=1').run()
  await createD1SessionStore(f.db).revoke(2,f.session.session.id)
  await expect(f.wrapped.batch([f.insert('Revoked session')])).rejects.toThrow()
  expect(await f.db.prepare('SELECT count(*) AS n FROM clients').first()).toEqual({n:0})
})
