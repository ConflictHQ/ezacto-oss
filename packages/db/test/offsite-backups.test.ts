import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { backupEncryptionKeyId, backupSha256, decryptBackupObject } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createOffsiteBackupSyncService,
  type OffsiteBackupSettings,
} from '../src/offsite-backups.js'
for (const runtime of ['SQLite', 'D1'])
  describe(`off-site backup checkpoints (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async (mode: 'legacy' | 'modern' | 'bad-size' = 'legacy') => {
      let db: Parameters<typeof createOffsiteBackupSyncService>[0]
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        db = createContainerDatabase(sqlite)
        close = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const d1 = await mf.getD1Database('DB')
        await migrateD1(d1)
        db = createD1Database(d1)
        close = async () => mf.dispose()
      }
      let now = '2026-10-01T09:00:00.000Z'
      const key = crypto.getRandomValues(new Uint8Array(32)),
        keyId = await backupEncryptionKeyId(key)
      const source = new Map<string, Uint8Array>(),
        remote = new Map<string, Uint8Array>(),
        puts: string[] = []
      const encode = (value: string) => new TextEncoder().encode(value)
      source.set(
        'backups/2026-10-01/tables/users.csv',
        encode('id,password_hash\n1,private-credential-material\n'),
      )
      source.set('backups/2026-10-01/tables/invoices.csv', encode('id,amount_cents\n1,10000\n'))
      source.set(
        'backups/2026-10-01/RESTORE.md',
        encode('Restore with the documented logical-bundle procedure.'),
      )
      const additional = new Map<string, Uint8Array>()
      if (mode !== 'legacy') {
        const blob = new Uint8Array([0,1,255]), blobHash = await backupSha256(blob)
        additional.set('schema.json', encode('{"tables":[]}'))
        additional.set('rows/users/000001.json', encode('[[1,null,""]]'))
        additional.set(`attachments/sha256/${blobHash.slice(0,2)}/${blobHash}`, blob)
        for (const [name,bytes] of additional) source.set('backups/2026-10-01/'+name,bytes)
      }
      const files = Object.fromEntries(await Promise.all([...additional].map(async ([name,bytes])=>[name,{sha256:await backupSha256(bytes),byte_size:bytes.length+(mode==='bad-size'&&name==='schema.json'?1:0)}])))
      const manifest = {
        schema_version: 1,
        bundle_version: mode === 'legacy' ? '0037' : '0038',
        ...(mode === 'legacy' ? {} : { files }),
        exported_at: now,
        tables: {
          users: {
            row_count: 1,
            sha256: await backupSha256(source.get('backups/2026-10-01/tables/users.csv')!),
          },
          invoices: {
            row_count: 1,
            sha256: await backupSha256(source.get('backups/2026-10-01/tables/invoices.csv')!),
          },
        },
        table_count: 2,
        total_rows: 2,
        restore_skips: [],
      }
      const json = JSON.stringify(manifest)
      source.set('backups/2026-10-01/manifest.json', encode(json))
      await db.run(sql`INSERT INTO backup_runs(id,status,trigger,started_at,completed_at,r2_prefix,manifest_json,table_count,total_rows,created_at,updated_at)
   VALUES(1,'completed','nightly',${now},${now},'backups/2026-10-01/',${json},2,2,${now},${now})`)
      let fail = false,
        pause = false,
        entered!: () => void,
        release!: () => void
      const waiting = new Promise<void>((resolve) => {
          entered = resolve
        }),
        released = new Promise<void>((resolve) => {
          release = resolve
        })
      const settings: OffsiteBackupSettings = {
        kind: 'ready',
        destinationId: 'd'.repeat(64),
        label: 's3.example.test/fixture',
        targetPrefix: 'instance/runs/',
        keyId,
        key,
        source: { get: async (name) => source.get(name) ?? null },
        target: {
          ensureObject: async (name, bytes) => {
            if (!remote.has(name)) {
              remote.set(name, new Uint8Array(bytes))
              puts.push(name)
            } else expect(remote.get(name)).toEqual(bytes)
            if (fail && puts.length === 2) {
              fail = false
              throw new Error('fixture queue response lost')
            }
            if (pause) {
              pause = false
              entered()
              await released
            }
            return { sha256: await backupSha256(bytes), size: bytes.length }
          },
        },
      }
      return {
        db,
        additional,
        source,
        remote,
        puts,
        key,
        settings,
        service: createOffsiteBackupSyncService(db, settings, () => now),
        advance: (stamp: string) => {
          now = stamp
        },
        fail: () => {
          fail = true
        },
        pause: () => {
          pause = true
        },
        entered: () => waiting,
        release: () => release(),
      }
    }
    it('includes every declared file in encrypted resumable plans, with manifest last', async () => {
      const f=await setup('modern')
      f.fail();await f.service.processDue()
      f.advance('2026-10-01T09:06:00.000Z');await f.service.processDue()
      expect(await f.service.status()).toMatchObject({state:'completed',latest:{total_objects:7,uploaded_objects:7}})
      expect(f.puts.at(-1)).toMatch(/manifest.json.ezenc$/)
      for(const [name,bytes] of f.remote){const plain=await decryptBackupObject(bytes,f.key);expect(plain.bytes).toEqual(f.source.get('backups/2026-10-01/'+plain.name));expect(name).toContain(plain.name+'.ezenc')}
    })
    it('refuses declared size mismatch before publishing a completion manifest', async () => {
      const f=await setup('bad-size');await f.service.processDue()
      expect(await f.service.status()).toMatchObject({state:'failed'})
      expect(f.puts.some(name=>name.endsWith('manifest.json.ezenc'))).toBe(false)
    })
    it('does not complete an older resumed journal that omitted newly declared files', async () => {
      const f=await setup('modern')
      if(f.settings.kind!=='ready')throw new Error('fixture configuration')
      const now='2026-10-01T09:00:00.000Z',json=new TextDecoder().decode(f.source.get('backups/2026-10-01/manifest.json'))
      await f.db.run(sql`INSERT INTO offsite_backup_syncs(id,backup_run_id,destination_id,destination_label,encryption_key_id,source_prefix,source_manifest_json,target_prefix,status,started_at,updated_at) VALUES('old-plan',1,${f.settings.destinationId},${f.settings.label},${f.settings.keyId},'backups/2026-10-01/',${json},'instance/runs/old/','running',${now},${now})`)
      await f.db.run(sql`INSERT INTO offsite_backup_objects(sync_id,name,encryption_key_id,nonce,source_sha256) VALUES('old-plan','RESTORE.md',${f.settings.keyId},${'A'.repeat(16)},${await backupSha256(f.source.get('backups/2026-10-01/RESTORE.md')!)})`)
      await f.db.run(sql`UPDATE offsite_backup_syncs SET status='pending' WHERE id='old-plan'`)
      await f.service.processDue()
      expect(await f.service.status()).toMatchObject({state:'failed'})
      expect(f.puts).toHaveLength(0)
    })
    it('resumes after an ambiguous upload, preserves encrypted bytes and commits the manifest last', async () => {
      const f = await setup()
      f.fail()
      await f.service.processDue()
      expect(await f.service.status()).toMatchObject({
        state: 'failed',
        error: { code: 'E14' },
        latest: { uploaded_objects: 1, total_objects: 4 },
      })
      expect(f.puts.some((name) => name.endsWith('manifest.json.ezenc'))).toBe(false)
      expect(await f.service.processDue()).toEqual({ uploaded: 0 })
      f.advance('2026-10-01T09:06:00.000Z')
      await f.service.processDue()
      expect(await f.service.status()).toMatchObject({
        state: 'completed',
        last_completed: { uploaded_objects: 4, total_objects: 4 },
      })
      expect(f.puts).toHaveLength(4)
      expect(f.puts.at(-1)).toMatch(/manifest.json.ezenc$/u)
      for (const [name, bytes] of f.remote) {
        expect(new TextDecoder().decode(bytes)).not.toContain('private-credential-material')
        const plain = await decryptBackupObject(bytes, f.key)
        expect(plain.bytes).toEqual(f.source.get('backups/2026-10-01/' + plain.name))
        expect(name).toContain(plain.name + '.ezenc')
      }
      await expect(async () => {
        await f.db.run(sql`UPDATE offsite_backup_objects SET nonce=${'A'.repeat(16)}`)
      }).rejects.toThrow()
      expect(await f.service.processDue()).toEqual({ uploaded: 0 })
    })
    it('reclaims a killed upload owner without repeating verified objects or letting the old owner settle', async () => {
      const f = await setup()
      f.pause()
      const old = f.service.processDue()
      await f.entered()
      expect(await f.service.processDue()).toEqual({ uploaded: 0 })
      f.advance('2026-10-01T09:03:00.000Z')
      await f.service.processDue()
      f.release()
      await old
      expect(await f.service.status()).toMatchObject({
        state: 'completed',
        last_completed: { uploaded_objects: 4 },
      })
      expect(f.puts).toHaveLength(4)
    })
    it('refuses changed source bytes and refuses completion or a manifest receipt before all objects', async () => {
      const f = await setup()
      f.source.set('backups/2026-10-01/tables/users.csv', new TextEncoder().encode('tampered'))
      await f.service.processDue()
      expect(await f.service.status()).toMatchObject({
        state: 'failed',
        error: { code: 'E14', message: expect.stringContaining('checksum') },
      })
      expect(f.puts.some((name) => name.endsWith('manifest.json.ezenc'))).toBe(false)
      await expect(async () => {
        await f.db.run(
          sql`UPDATE offsite_backup_syncs SET status='completed',completed_at='2026-10-01T09:01:00.000Z'`,
        )
      }).rejects.toThrow()
      await expect(async () => {
        await f.db.run(
          sql`UPDATE offsite_backup_objects SET uploaded_at='2026-10-01T09:01:00.000Z',cipher_sha256=${'a'.repeat(64)},cipher_size=1 WHERE name='manifest.json'`,
        )
      }).rejects.toThrow()
    })
  })
