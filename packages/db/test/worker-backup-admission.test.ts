import { Miniflare } from 'miniflare'
import { describe, it, expect } from 'vitest'
import { workerBackupCaptureMigration } from '../src/migrations/0176_worker_backup_capture.js'
import { exportBundle } from '../src/backup.js'

describe('Worker snapshot atomic memory admission', () => {
  it('refuses oversized data before returning rows; clears admission and permits concurrent later captures', async () => {
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']})
    try {
      const db=await mf.getD1Database('DB')
      await db.batch(workerBackupCaptureMigration.map(sql=>db.prepare(sql)))
      await db.prepare('CREATE TABLE sample(id INTEGER PRIMARY KEY,payload BLOB)').run()
      await db.batch(Array.from({length:9},(_,i)=>db.prepare('INSERT INTO sample VALUES (?,zeroblob(1000000))').bind(i)))
      let returnedRows=0, puts=0
      const wrapped=new Proxy(db,{get(target,key){if(key==='batch')return async (statements: D1PreparedStatement[])=>{const results=await target.batch(statements as never);for(const result of results) returnedRows+=result.results.filter((row:unknown)=>typeof row==='object'&&row!==null&&'encoded' in row).length;return results}; const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}}) as unknown as D1Database
      await expect(exportBundle(wrapped,{async put(){puts++}},'large/')).rejects.toThrow(/in-memory budget/)
      expect(returnedRows).toBe(0);expect(puts).toBe(0)
      expect(await db.prepare('SELECT admitted,estimated_bytes FROM worker_backup_capture').first()).toEqual({admitted:0,estimated_bytes:0})
      await db.prepare('DELETE FROM sample').run()
      await db.prepare("INSERT INTO sample VALUES (1,X'0011')").run()
      const outputs=await Promise.all(['a/','b/'].map(prefix=>exportBundle(db as unknown as D1Database,{async put(){}},prefix)))
      expect(outputs.map(out=>out.tables.sample?.row_count)).toEqual([1,1])
      expect(await db.prepare('SELECT admitted,estimated_bytes FROM worker_backup_capture').first()).toEqual({admitted:0,estimated_bytes:0})
      let batches=0
      const broken=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>target.batch((++batches===2?[...statements,target.prepare('SELECT nonexistent FROM sample')]:statements) as never);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}}) as unknown as D1Database
      await expect(exportBundle(broken,{async put(){}},'failed/')).rejects.toThrow()
      expect(await db.prepare('SELECT admitted,estimated_bytes FROM worker_backup_capture').first()).toEqual({admitted:0,estimated_bytes:0})
    } finally {await mf.dispose()}
  },60000)
})
