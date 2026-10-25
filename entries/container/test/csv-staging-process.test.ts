import BetterSqlite3 from 'better-sqlite3'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, realpath, rm, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { migrateContainer, createContainerSessionStore } from '@ezacto/db'

/** Actual shipped process and neighboring worker bundle; no injected parser/runtime port. */
it('serves private staging and zero-write preview through the bundled Container process', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csv-process-owned-'))), data = join(root, 'data')
  await mkdir(data, { mode: 0o700 })
  const db = new BetterSqlite3(join(data, 'db.sqlite'))
  let child: ReturnType<typeof spawn> | undefined
  let stopped: Promise<void> | undefined
  let output = ''
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await symlink(join(process.cwd(), '../../node_modules'), join(root, 'node_modules'), 'dir')
    for (const [source, target] of [['index.ts', 'index.mjs'], ['csv-staging-worker.ts', 'csv-staging-worker.js']] as const) {
      await build({ entryPoints: [join(process.cwd(), 'src', source)], outfile: join(root, target), bundle: true, conditions: ['development'], platform: 'node', format: 'esm', target: 'node22', external: ['better-sqlite3', 'nodemailer'], logLevel: 'silent' })
    }
    migrateContainer(db)
    const at = new Date().toISOString()
    const seed = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params)
    seed("INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned process','{}',?,?)", at, at)
    for (const id of [1, 2]) seed("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(?,'Owned','Person','administrator','[]',?,?)", id, at, at)
    seed("INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(1,'ann@example.test',1,?,?,?)", at, at, at)
    seed("INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'C','EUR',?,?)", at, at)
    seed("INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'P',?,?)", at, at)
    seed("INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'T',?,?)", at, at)
    seed('INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(1,1,?,?)', at, at)
    seed('INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,?,?)', at, at)
    const session = await createContainerSessionStore(db).issue(2)
    const listener = createServer()
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Owned loopback port unavailable')
    const port = address.port
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    const origin = `http://localhost:${port}`
    child = spawn(process.execPath, [join(root, 'index.mjs')], { cwd: root, env: {
      PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), EZACTO_DATA_DIR: data,
      APP_BASE_URL: origin, API_CURSOR_SIGNING_KEY: Buffer.alloc(32, 0x43).toString('base64url'),
      SMTP_URL: 'smtp://127.0.0.1:9', SMTP_FROM: 'owned@example.test', RELEASE: 'csv-owned-process',
    }, stdio: ['ignore', 'pipe', 'pipe'] })
    stopped = new Promise<void>(resolve => child!.once('exit', () => resolve()))
    child.stdout!.on('data', value => { output = (output + String(value)).slice(-8000) })
    child.stderr!.on('data', value => { output = (output + String(value)).slice(-8000) })
    await expect.poll(async () => {
      if (child!.exitCode !== null) throw new Error(`Owned Container exited: ${output}`)
      return fetch(`${origin}/healthz`).then(response => response.status).catch(() => 0)
    }, { timeout: 10000, interval: 100 }).toBe(200)
    const request = (path: string, init: RequestInit = {}, authenticated = true) => fetch(`${origin}/api/v1${path}`, {
      ...init, headers: { origin, ...(authenticated ? { cookie: `__Host-ezacto_session=${session.token}` } : {}), ...init.headers },
    })
    const capability = await request('/csv-import-capabilities')
    expect(capability.status).toBe(200)
    expect(await capability.json()).toMatchObject({ data: { runtime: 'container', staging_supported: true, browser_ready: false, apply_supported: false } })
    const csv = new TextEncoder().encode('Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\nann@example.test,C,P,T,owned process private note,Yes,2026-09-01,09:00:00,2026-09-01,09:01:00,00:01:00\n')
    const headers = { 'content-type': 'application/octet-stream', 'x-csv-bytes': String(csv.length), 'x-csv-sha256': createHash('sha256').update(csv).digest('hex') }
    expect((await request('/csv-imports', { method: 'POST', headers, body: csv }, false)).status).toBe(401)
    const upload = await request('/csv-imports', { method: 'POST', headers, body: csv })
    expect(upload.status).toBe(201)
    const staged = ((await upload.json()) as {data:{ id: string; version: number }}).data
    const mapped = await request(`/csv-imports/${staged.id}/mapping`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: staged.version, workspace_identity: 'owned-clockify-process', exporter_zone: 'UTC', date_format: 'iso', destination_interpretation: 'source_wall_time', currency_policy: 'destination_rates', mapping: {}, excluded_lines: [] }) })
    expect(mapped.status).toBe(200)
    const fingerprint = () => JSON.stringify(['users', 'clients', 'projects', 'tasks', 'user_assignments', 'task_assignments', 'time_entries', 'csv_import_runs', 'csv_import_entries', 'event_outbox'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
    const before = fingerprint()
    const preview = await request(`/csv-imports/${staged.id}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(preview.status, output).toBe(200)
    expect(await preview.json()).toMatchObject({ data: { organization_name: 'Owned process', tallies: { new_rows: 1, source_seconds: 60, destination_seconds: 60, unpriced: true } } })
    expect(fingerprint()).toBe(before)
    expect(db.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) AS n FROM csv_import_runs').get()).toEqual({ n: 0 })
    expect((await request(`/csv-imports/${staged.id}/input`, { method: 'DELETE' })).status).toBe(204)
    expect(output).not.toContain('owned process private note')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => { child?.kill('SIGKILL') }, 5000)
      try { await stopped } finally { clearTimeout(timer) }
    }
    db.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
