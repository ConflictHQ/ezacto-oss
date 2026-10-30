import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackup } from '../src/backup.js'
import { runCli } from '../src/cli.js'
import { createS3Client } from '../src/s3.js'
import { syncBundle, type SyncDestination } from '../src/sync.js'
import {
  FAKE_S3_ACCESS_KEY,
  FAKE_S3_BUCKET,
  FAKE_S3_REGION,
  FAKE_S3_SECRET,
  startFakeS3,
  type FakeS3,
  type FakeS3Options,
} from './helpers/fake-s3.js'

let workDirectory: string
let databasePath: string
let attachmentDirectory: string
let server: FakeS3 | undefined

beforeEach(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ezacto-sync-'))
  databasePath = join(workDirectory, 'source.sqlite')
  attachmentDirectory = join(workDirectory, 'attachments')
  await mkdir(join(attachmentDirectory, 'sha256', 'ab'), { recursive: true })
  await writeFile(join(attachmentDirectory, 'sha256', 'ab', 'abcdef'), 'attachment bytes')
  const database = new BetterSqlite3(databasePath)
  database.exec(`
    CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO clients (id, name) VALUES (1, 'Northpeak'), (2, 'Eagle');
    INSERT INTO projects (id, name) VALUES (1, 'Retainer');
  `)
  database.close()
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(workDirectory, { recursive: true, force: true })
})

const makeBundle = async (): Promise<string> =>
  (
    await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: join(workDirectory, 'out'),
      now: new Date('2026-10-19T01:00:00Z'),
    })
  ).bundleDirectory

const destination = (prefix = 'nightly'): SyncDestination => ({
  client: createS3Client({
    endpoint: server!.endpoint,
    region: FAKE_S3_REGION,
    accessKeyId: FAKE_S3_ACCESS_KEY,
    secretAccessKey: FAKE_S3_SECRET,
    addressing: 'path',
  }),
  bucket: FAKE_S3_BUCKET,
  prefix,
})

const start = async (options: FakeS3Options = {}): Promise<FakeS3> => {
  server = await startFakeS3(options)
  return server
}

describe('syncBundle', () => {
  it('uploads every object with a verified checksum and writes the manifest last', async () => {
    await start()
    const bundle = await makeBundle()
    const result = await syncBundle(bundle, destination())

    const root = `nightly/${basename(bundle)}`
    expect(result.uploaded).toBe(6)
    expect(result.skipped).toBe(0)
    expect([...server!.objects.keys()].sort()).toEqual(
      [
        'RESTORE.md',
        'attachments/sha256/ab/abcdef',
        'db.sqlite',
        'manifest.json',
        'tables/clients.csv',
        'tables/projects.csv',
      ]
        .map((path) => `${root}/${path}`)
        .sort(),
    )
    for (const [key, stored] of server!.objects) {
      const local = await readFile(join(bundle, key.slice(root.length + 1)))
      expect(createHash('sha256').update(stored.body).digest('hex')).toBe(
        createHash('sha256').update(local).digest('hex'),
      )
      expect(stored.checksum).toBe(createHash('sha256').update(local).digest('base64'))
    }
    const puts = server!.puts()
    expect(puts.at(-1)).toBe(`${root}/manifest.json`)
    expect(puts.filter((key) => key.endsWith('manifest.json'))).toHaveLength(1)
  })

  it('resumes a sync that died halfway: matching objects are skipped, the manifest still goes last', async () => {
    await start({ dieOnPut: 4 })
    const bundle = await makeBundle()
    const root = `nightly/${basename(bundle)}`

    await expect(syncBundle(bundle, destination())).rejects.toThrow(/cannot reach|fetch failed/)
    // Three objects landed and the manifest did not: the prefix reads as incomplete.
    expect(server!.objects.size).toBe(3)
    expect(server!.objects.has(`${root}/manifest.json`)).toBe(false)
    const firstRunKeys = new Set(server!.objects.keys())
    const requestsBefore = server!.requests.length

    const result = await syncBundle(bundle, destination())
    expect(result.skipped).toBe(3)
    expect(result.uploaded).toBe(3)
    const secondRunPuts = server!.requests
      .slice(requestsBefore)
      .filter((entry) => entry.method === 'PUT')
      .map((entry) => entry.key)
    expect(secondRunPuts).toHaveLength(3)
    for (const key of secondRunPuts) expect(firstRunKeys.has(key)).toBe(false)
    expect(secondRunPuts.at(-1)).toBe(`${root}/manifest.json`)
    expect(server!.objects.size).toBe(6)
  })

  it('uploads nothing when everything is already there', async () => {
    await start()
    const bundle = await makeBundle()
    await syncBundle(bundle, destination())
    const putsBefore = server!.puts().length
    const result = await syncBundle(bundle, destination())
    expect(result).toMatchObject({ uploaded: 0, skipped: 6, uploadedBytes: 0 })
    expect(server!.puts()).toHaveLength(putsBefore)
  })

  it('replaces an object whose remote checksum differs', async () => {
    await start()
    const bundle = await makeBundle()
    await syncBundle(bundle, destination())
    const key = `nightly/${basename(bundle)}/tables/clients.csv`
    server!.objects.set(key, { body: Buffer.from('tampered'), checksum: 'AAAA' })
    const result = await syncBundle(bundle, destination())
    expect(result.uploaded).toBe(1) // only the table; the unchanged manifest is skipped
    expect(server!.objects.get(key)!.body.toString()).toContain('Northpeak')
  })

  it('uploads with a write-only credential that cannot HEAD', async () => {
    await start({ putOnly: true })
    const bundle = await makeBundle()
    const result = await syncBundle(bundle, destination())
    expect(result.uploaded).toBe(6)
    expect(server!.objects.size).toBe(6)
  })

  it('refuses a bundle with a missing manifest before any request', async () => {
    await start()
    const bundle = await makeBundle()
    await unlink(join(bundle, 'manifest.json'))
    await expect(syncBundle(bundle, destination())).rejects.toThrow(
      /refusing to sync.*cannot read manifest/s,
    )
    expect(server!.requests).toEqual([])
  })

  it('refuses a bundle whose file hash does not match before any request', async () => {
    await start()
    const bundle = await makeBundle()
    await writeFile(join(bundle, 'tables', 'clients.csv'), 'id,name\n9,forged\n')
    await expect(syncBundle(bundle, destination())).rejects.toThrow(
      /refusing to sync.*CSV checksum mismatch for clients/s,
    )
    await writeFile(join(bundle, 'db.sqlite'), 'not the database')
    await expect(syncBundle(bundle, destination())).rejects.toThrow(/database checksum mismatch/)
    expect(server!.requests).toEqual([])
  })

  it('refuses a manifest path that leaves the bundle', async () => {
    await start()
    const bundle = await makeBundle()
    const outside = join(workDirectory, 'out', 'outside.txt')
    await writeFile(outside, 'secret')
    const manifestPath = join(bundle, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      attachments: Array<{ path: string; sha256: string; byte_size: number }>
    }
    manifest.attachments.push({
      path: 'attachments/../../outside.txt',
      sha256: createHash('sha256').update('secret').digest('hex'),
      byte_size: 6,
    })
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(syncBundle(bundle, destination())).rejects.toThrow(/leaves the bundle/)
    expect(server!.requests).toEqual([])
  })

  it('fails visibly when the bucket is wrong, and leaves nothing behind', async () => {
    await start()
    const bundle = await makeBundle()
    await expect(
      syncBundle(bundle, { ...destination(), bucket: 'no-such-bucket' }),
    ).rejects.toThrow(/NoSuchBucket.*bucket does not exist/)
    expect(server!.objects.size).toBe(0)
  })
})

describe('ez backup --sync-to', () => {
  const runtime = (environment: Record<string, string>) => {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      runtime: {
        environment: environment as NodeJS.ProcessEnv,
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
        readStdin: () => Promise.resolve(''),
      },
    }
  }
  const environment = () => ({
    AWS_ACCESS_KEY_ID: FAKE_S3_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: FAKE_S3_SECRET,
    EZACTO_S3_ENDPOINT: server!.endpoint,
    EZACTO_S3_REGION: FAKE_S3_REGION,
  })

  it('creates a bundle and copies it off-platform', async () => {
    await start()
    const { out, err, runtime: cli } = runtime(environment())
    const code = await runCli(
      [
        'backup',
        '--database',
        databasePath,
        '--attachments',
        attachmentDirectory,
        '--output',
        join(workDirectory, 'out'),
        '--sync-to',
        `s3://${FAKE_S3_BUCKET}/nightly`,
      ],
      cli,
    )
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/synced to s3:\/\/ezacto-offsite\/nightly\/ezacto-backup-/)
    expect(out.join('\n')).toContain('uploaded: 6, already present: 0')
    expect(err.join('\n')).toContain('warning: the bundle is sent as is, not encrypted')
    expect(server!.objects.size).toBe(6)
    expect(server!.puts().at(-1)).toMatch(/manifest\.json$/)
  })

  it('resumes an existing bundle with --bundle and reports what was skipped', async () => {
    await start({ dieOnPut: 5 })
    const bundle = await makeBundle()
    const args = ['backup', '--bundle', bundle, '--sync-to', `s3://${FAKE_S3_BUCKET}`, '--json']
    await expect(runCli(args, runtime(environment()).runtime)).rejects.toThrow()

    const { out, runtime: cli } = runtime(environment())
    expect(await runCli(args, cli)).toBe(0)
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      sync: { objects: 6, uploaded: 2, already_present: 4 },
    })
  })

  it('reports a missing credential without contacting the bucket', async () => {
    await start()
    const bundle = await makeBundle()
    const { runtime: cli } = runtime({})
    await expect(
      runCli(['backup', '--bundle', bundle, '--sync-to', `s3://${FAKE_S3_BUCKET}`], cli),
    ).rejects.toThrow(/AWS_ACCESS_KEY_ID/)
    expect(server!.requests).toEqual([])
  })

  it('rejects the sync flags on other commands and --bundle without --sync-to', async () => {
    await start()
    const { runtime: cli } = runtime(environment())
    await expect(runCli(['restore', 'x', '--sync-to', 's3://b'], cli)).rejects.toThrow(
      /valid only with ez backup/,
    )
    await expect(runCli(['backup', '--bundle', 'x'], cli)).rejects.toThrow(/--bundle needs --sync-to/)
  })
})
