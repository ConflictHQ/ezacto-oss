import BetterSqlite3 from 'better-sqlite3'
import { createBackup, restoreBackup } from '../src/backup.js'
import {
  quarantineRestoredDatabase,
  replayClosureHistory,
  releasePrivacyQuarantine,
} from '../../../entries/container/src/privacy-restore.js'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { createContainerSessionStore } from '../../db/src/sessions.js'
import { createCalendarOperatorCleanupStore } from '../../db/src/calendar-operator-cleanup.js'
import { createCalendarConnectionStore } from '../../db/src/calendar-connections.js'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calendarOperatorFixture } from '../../db/test/support/calendar-operator-fixture.js'
import { createApiApp } from '../../api/src/app.js'
import { createApiSessionService } from '../../api/src/sessions.js'
import { installCalendarOperatorCleanupRoutes } from '../../api/src/calendar-operator-cleanup.js'
import { calendarCleanupCommand } from '../src/calendar-cleanup.js'
const close: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(close.splice(0).map((fn) => fn()))
})
it('uses the real native administrator API through private stdin and inspects offline without changing custody', async () => {
  const f = await calendarOperatorFixture('sqlite')
  close.push(f.close)
  await f.seed()
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-calendar-operator-'))
  close.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'restored.sqlite')
  await f.sqlite!.backup(path)
  const output: string[] = []
  await calendarCleanupCommand(['inspect', await realpath(path)], {
    readStdin: async () => {
      throw new Error('must not read credentials')
    },
    stdout: (text) => output.push(text),
  })
  expect(output[0]).not.toContain('PRIVATE_SEALED_GRANT')
  expect(JSON.parse(output[0]!).inspection_only).toBe(true)
  expect(await f.rows('SELECT count(*) AS n FROM calendar_operator_cleanup_receipts')).toEqual([
    { n: 0 },
  ])
  const app = createApiApp({
    authentication: { sessions: createApiSessionService(f.sessions) },
    installApi: (api) => installCalendarOperatorCleanupRoutes(api, f.store),
  })
  const requests: Array<{
    method: string
    authorization: string | null
    redirect: RequestRedirect | undefined
  }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    expect(new URL(request.url).origin).toBe('https://owned.example')
    requests.push({
      method: request.method ?? 'GET',
      authorization: request.headers.get('authorization'),
      redirect: init?.redirect,
    })
    return app.fetch(request)
  })
  const base = {
    base_url: 'https://owned.example',
    session_cookie: '__Host-ezacto_session=' + f.issued.token,
  }
  const io = (value: unknown) => ({
    readStdin: async () => JSON.stringify(value),
    stdout: (text: string) => output.push(text),
  })
  await calendarCleanupCommand(['list'], io(base))
  const selection = JSON.parse(output.at(-1)!).data[0]
  await calendarCleanupCommand(
    ['confirm'],
    io({
      ...base,
      selection,
      evidence_reference: 'Protected ticket CAL-1316: external removal verified.',
      confirm_provider_removed: true,
    }),
  )
  expect(JSON.parse(output.at(-1)!).data).toMatchObject({
    kind: 'operator_attestation',
    provider_verified: false,
  })
  expect(output.join('')).not.toContain(f.issued.token)
  expect(output.join('')).not.toContain('Protected ticket')
  expect(requests.map((row) => row.method)).toEqual(['GET', 'POST'])
  expect(requests.every((row) => row.authorization === null && row.redirect === 'error')).toBe(true)
  expect(await f.rows('SELECT count(*) AS n FROM calendar_operator_cleanup_receipts')).toEqual([
    { n: 1 },
  ])
})
it('rejects insecure origins and arbitrary credential properties', async () => {
  for (const input of [
    {
      base_url: 'http://foreign.example',
      session_cookie: '__Host-ezacto_session=' + 'a'.repeat(43),
    },
    {
      base_url: 'https://owned.example',
      session_cookie: '__Host-ezacto_session=' + 'a'.repeat(43),
      token: 'private',
    },
  ])
    await expect(
      calendarCleanupCommand(['list'], {
        readStdin: async () => JSON.stringify(input),
        stdout: () => {},
      }),
    ).rejects.toThrow()
})

it('runs the built operator CLI over trusted local TLS and leaves offline inspection byte-identical', async () => {
  const f = await calendarOperatorFixture('sqlite')
  close.push(f.close)
  await f.seed()
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-calendar-cli-'))
  close.push(() => rm(directory, { recursive: true, force: true }))
  const cert = join(directory, 'cert.pem'),
    key = join(directory, 'key.pem')
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  )
  expect(generated.status).toBe(0)
  const app = createApiApp({
    authentication: { sessions: createApiSessionService(f.sessions) },
    installApi: (api) => installCalendarOperatorCleanupRoutes(api, f.store),
  })
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const url = `https://localhost:${(server.address() as { port: number }).port}${request.url}`
        const result = await app.fetch(
          new Request(url, {
            method: request.method ?? 'GET',
            headers: request.headers as Record<string, string>,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          }),
        )
        response.writeHead(result.status, Object.fromEntries(result.headers))
        response.end(Buffer.from(await result.arrayBuffer()))
      })().catch(() => {
        response.writeHead(500)
        response.end('fixture failure')
      })
    },
  )
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  close.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const command = (args: string[], input = '') =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'calendar-cleanup', ...args], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (status) => resolve({ status, stdout, stderr }))
      child.stdin.end(input)
    })
  const path = join(directory, 'offline.sqlite')
  await f.sqlite!.backup(path)
  const before = await readFile(path),
    inspected = await command(['inspect', await realpath(path)])
  expect(inspected.status).toBe(0)
  expect(inspected.stdout).not.toContain('PRIVATE_SEALED_GRANT')
  expect(await readFile(path)).toEqual(before)
  const base = {
    base_url: `https://localhost:${(server.address() as { port: number }).port}`,
    session_cookie: '__Host-ezacto_session=' + f.issued.token,
  }
  const listed = await command(['list'], JSON.stringify(base))
  expect(listed.status).toBe(0)
  const selection = JSON.parse(listed.stdout).data[0]
  const confirmed = await command(
    ['confirm'],
    JSON.stringify({
      ...base,
      selection,
      evidence_reference: 'Protected local acceptance CAL-1316: removal verified.',
      confirm_provider_removed: true,
    }),
  )
  expect(confirmed.status).toBe(0)
  expect(JSON.parse(confirmed.stdout).data).toMatchObject({
    kind: 'operator_attestation',
    provider_verified: false,
  })
  expect(confirmed.stdout + confirmed.stderr).not.toContain(f.issued.token)
  expect(await f.rows('SELECT count(*) AS n FROM calendar_operator_cleanup_receipts')).toEqual([
    { n: 1 },
  ])
}, 20000)

it('recovers an actual restored grant after offline inspection and the existing privacy release', async () => {
  const f = await calendarOperatorFixture('sqlite')
  close.push(f.close)
  await f.run(
    "INSERT INTO calendar_connections(user_id,provider,instance_nonce,generation,credential_revision,status,key_id,sealed_grant,updated_at) VALUES(3,'google',?,1,1,'connected','old-key','PRIVATE_RESTORED_GRANT',?)",
    f.instance,
    f.now,
  )
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-calendar-restore-'))
  close.push(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'current.sqlite'),
    targetPath = join(directory, 'restored.sqlite')
  await f.sqlite!.backup(source)
  const bundle = await createBackup({
    databasePath: source,
    outputDirectory: join(directory, 'backup'),
  })
  await restoreBackup({ bundleDirectory: bundle.bundleDirectory, targetDatabasePath: targetPath })
  const target = new BetterSqlite3(targetPath),
    current = new BetterSqlite3(source, { readonly: true })
  close.push(async () => {
    target.close()
    current.close()
  })
  quarantineRestoredDatabase(target)
  const output: string[] = []
  await calendarCleanupCommand(['inspect', await realpath(targetPath)], {
    readStdin: async () => '',
    stdout: (value) => output.push(value),
  })
  const review = JSON.parse(output[0]!).data[0]
  expect(review.reason).toBe('restore')
  expect(review.instance_nonce).toBe(f.instance)
  expect(review.review_instance).not.toBe(f.instance)
  expect(output[0]).not.toContain('PRIVATE_RESTORED_GRANT')
  const db = createContainerDatabase(target),
    store = createCalendarOperatorCleanupStore(db),
    sessions = createContainerSessionStore(target)
  await expect(store.list(f.actor)).rejects.toMatchObject({ code: 'forbidden' })
  replayClosureHistory(target, current)
  releasePrivacyQuarantine(
    target,
    current,
    'Protected restore ticket: current privacy and provider cleanup reviewed.',
  )
  const actor = { userId: 1, sessionId: (await sessions.issue(1)).session.id }
  const row = (await store.list(actor)).data[0]!,
    { status, created_at: _, provider_cleanup_in_progress: __, ...identity } = row
  void _
  void __
  const result = await store.confirm(actor, {
    ...identity,
    expected_status: status,
    evidence_reference: 'Protected restore ticket: exact provider permission removed.',
    confirm_provider_removed: true,
  })
  expect(result.provider_verified).toBe(false)
  const user = { userId: 3, sessionId: (await sessions.issue(3)).session.id }
  const connection = createCalendarConnectionStore(db)
  await connection.connect(
    user,
    'google',
    2,
    { instance: review.review_instance, keyId: 'new-key', sealedGrant: 'NEW_PRIVATE' },
    new Date().toISOString(),
  )
  expect(target.prepare('SELECT status FROM calendar_connections').get()).toEqual({
    status: 'connected',
  })
}, 30000)
