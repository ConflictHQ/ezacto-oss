import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../../..', import.meta.url).pathname
const suffix = `${process.pid}-${Date.now()}`
const image = `ezacto-container-test:${suffix}`
const volume = `ezacto-container-test-source-${suffix}`
const restoredVolume = `ezacto-container-test-restored-${suffix}`
const firstName = `ezacto-container-first-${suffix}`
const secondName = `ezacto-container-second-${suffix}`
const sharedSourceName = `ezacto-container-shared-source-${suffix}`
const attachedTargetName = `ezacto-container-attached-target-${suffix}`
const cursorKey = Buffer.alloc(32, 0x44).toString('base64url')
const password = 'correct horse battery staple'

const command = (program, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code, stdout, stderr })
      } else {
        reject(
          new Error(
            `${program} ${args[0] ?? ''} failed (${code})\n${stdout}${stderr}`,
          ),
        )
      }
    })
  })

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not reserve a TCP port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })

const createSmtpCapture = () => {
  const messages = []
  const waiters = []
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    socket.write('220 capture.test ESMTP ready\r\n')
    let buffer = ''
    let data = false
    let message = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\r\n')) {
        const ending = buffer.indexOf('\r\n')
        const line = buffer.slice(0, ending)
        buffer = buffer.slice(ending + 2)
        if (data) {
          if (line === '.') {
            messages.push(message)
            waiters.splice(0).forEach((resolve) => resolve())
            message = ''
            data = false
            socket.write(`250 queued as capture-${messages.length}\r\n`)
          } else {
            message += `${line}\r\n`
          }
          continue
        }
        if (/^(?:EHLO|HELO) /iu.test(line)) {
          socket.write('250-capture.test\r\n250 PIPELINING\r\n')
        } else if (/^(?:MAIL FROM:|RCPT TO:)/iu.test(line)) {
          socket.write('250 accepted\r\n')
        } else if (line === 'DATA') {
          data = true
          socket.write('354 end with dot\r\n')
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n')
        } else {
          socket.write('250 ok\r\n')
        }
      }
    })
  })
  return {
    messages,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '0.0.0.0', resolve)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('SMTP capture did not bind')
      }
      return address.port
    },
    async next(timeoutMs = 10_000) {
      if (messages.length > 0) return messages.at(-1)
      let timeout
      try {
        await Promise.race([
          new Promise((resolve) => waiters.push(resolve)),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('SMTP capture timed out')),
              timeoutMs,
            )
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
      return messages.at(-1)
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

const waitForHealth = async (origin, container) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/healthz`)
      if (response.ok) return
    } catch {
      // The process is still migrating or the port is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const logs = await command('docker', ['logs', container], {
    allowFailure: true,
  })
  throw new Error(
    `container did not become healthy\n${logs.stdout}${logs.stderr}`,
  )
}

const request = async (origin, path, payload, cookie) => {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${JSON.stringify(body)}`,
    )
  }
  return { response, body }
}

const runContainer = async (name, appPort, smtpPort, dataVolume) => {
  await command('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--add-host',
    'host.docker.internal:host-gateway',
    '--publish',
    `127.0.0.1:${appPort}:3000`,
    '--mount',
    `type=volume,source=${dataVolume},target=/data`,
    '--env',
    `APP_BASE_URL=http://localhost:${appPort}`,
    '--env',
    `API_CURSOR_SIGNING_KEY=${cursorKey}`,
    '--env',
    `SMTP_URL=smtp://host.docker.internal:${smtpPort}`,
    '--env',
    'SMTP_FROM=Ezacto <billing@example.test>',
    '--env',
    `RELEASE=${suffix}`,
    image,
  ])
}

const createVolumeReference = (name, dataVolume) =>
  command('docker', [
    'container',
    'create',
    '--name',
    name,
    '--mount',
    `type=volume,source=${dataVolume},target=/data`,
    '--entrypoint',
    'node',
    image,
    '-e',
    'process.exit(0)',
  ])

const expectFailure = async (program, args, expected) => {
  const result = await command(program, args, { allowFailure: true })
  if (result.code === 0 || !result.stderr.includes(expected)) {
    throw new Error(
      `expected command failure containing ${JSON.stringify(expected)}\n${result.stdout}${result.stderr}`,
    )
  }
}

const cleanup = async (smtp, dockerAvailable, temporaryRoot) => {
  if (dockerAvailable) {
    await Promise.all(
      [firstName, secondName, sharedSourceName, attachedTargetName].map(
        (name) =>
          command('docker', ['rm', '--force', name], { allowFailure: true }),
      ),
    )
    await Promise.all(
      [volume, restoredVolume].map((name) =>
        command('docker', ['volume', 'rm', '--force', name], {
          allowFailure: true,
        }),
      ),
    )
    await command('docker', ['image', 'rm', '--force', image], {
      allowFailure: true,
    })
  }
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  await smtp?.close()
}

let smtp
let dockerAvailable = false
let temporaryRoot
try {
  await command('docker', ['version'])
  dockerAvailable = true
  smtp = createSmtpCapture()
  const [smtpPort, appPort] = await Promise.all([smtp.listen(), freePort()])
  const origin = `http://localhost:${appPort}`
  temporaryRoot = await mkdtemp(join(tmpdir(), 'ezacto-container-restore-'))
  const bundle = join(temporaryRoot, 'snapshot')
  await command('docker', ['build', '--tag', image, '.'])
  await command('docker', ['volume', 'create', volume])
  await runContainer(firstName, appPort, smtpPort, volume)
  await waitForHealth(origin, firstName)

  await request(origin, '/auth/signup', {
    organization_name: 'Container Acceptance',
    first_name: 'Avery',
    last_name: 'Ng',
    email: 'owner@example.test',
    password,
  })
  const rawMessage = await smtp.next()
  const decoded = rawMessage.replace(/=\r\n/gu, '').replaceAll('=3D', '=')
  const token = /ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/u.exec(
    decoded,
  )?.[0]
  if (token === undefined)
    throw new Error('verification token missing from SMTP message')
  await request(origin, '/auth/verify-email', { token })
  const signedIn = await request(origin, '/auth/sign-in', {
    email: 'owner@example.test',
    password,
  })
  const cookie = signedIn.response.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined)
    throw new Error('sign-in did not issue a session cookie')

  const created = async (path, payload) =>
    (await request(origin, `/api/v1/${path}`, payload, cookie)).body.data
  const client = await created('clients', { name: 'Acceptance Client' })
  const task = await created('tasks', { name: 'Development' })
  const project = await created('projects', {
    client_id: client.id,
    name: 'Container Project',
  })
  await created('task-assignments', {
    project_id: project.id,
    task_id: task.id,
  })
  await created('user-assignments', { project_id: project.id, user_id: 1 })
  const entry = await created('time-entries', {
    project_id: project.id,
    task_id: task.id,
    spent_date: '2026-08-31',
    seconds: 1_800,
    notes: 'Docker first-run acceptance',
  })
  const attachmentBytes = Buffer.from('Docker physical restore attachment')
  const form = new FormData()
  form.append(
    'file',
    new Blob([attachmentBytes], { type: 'text/plain' }),
    'restore-proof.txt',
  )
  const attachmentResponse = await fetch(
    `${origin}/api/v1/projects/${project.id}/attachments`,
    {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'idempotency-key': 'docker-physical-restore-attachment',
      },
      body: form,
    },
  )
  const attachmentBody = await attachmentResponse.json()
  if (
    !attachmentResponse.ok ||
    attachmentBody.data?.content_hash !==
      createHash('sha256').update(attachmentBytes).digest('hex')
  ) {
    throw new Error(
      `attachment upload failed: ${JSON.stringify(attachmentBody)}`,
    )
  }

  await command('docker', [
    'exec',
    firstName,
    'node',
    '-e',
    "if(process.getuid()===0)process.exit(1);require('fs').accessSync('/data/db.sqlite')",
  ])
  await command('docker', ['stop', '--timeout', '30', firstName])
  await createVolumeReference(sharedSourceName, volume)
  await expectFailure(
    process.execPath,
    [
      'scripts/container-physical-snapshot.mjs',
      'backup',
      '--container',
      firstName,
      '--output',
      bundle,
    ],
    'source volume must be referenced only by the stopped source container',
  )
  await command('docker', ['rm', sharedSourceName])
  await command(process.execPath, [
    'scripts/container-physical-snapshot.mjs',
    'backup',
    '--container',
    firstName,
    '--output',
    bundle,
  ])
  await command('docker', ['rm', firstName])
  await command('docker', ['volume', 'rm', volume])

  await command('docker', ['volume', 'create', restoredVolume])
  await createVolumeReference(attachedTargetName, restoredVolume)
  await expectFailure(
    process.execPath,
    [
      'scripts/container-physical-snapshot.mjs',
      'restore',
      '--bundle',
      bundle,
      '--volume',
      restoredVolume,
      '--image',
      image,
    ],
    'target volume must not be referenced by any container',
  )
  await command('docker', ['rm', attachedTargetName])
  await command(process.execPath, [
    'scripts/container-physical-snapshot.mjs',
    'restore',
    '--bundle',
    bundle,
    '--volume',
    restoredVolume,
    '--image',
    image,
  ])
  await runContainer(secondName, appPort, smtpPort, restoredVolume)
  await waitForHealth(origin, secondName)
  const restored = await fetch(`${origin}/api/v1/time-entries/${entry.id}`, {
    headers: { cookie },
  })
  const restoredBody = await restored.json()
  if (
    !restored.ok ||
    restoredBody.data?.seconds !== 1_800 ||
    restoredBody.data?.notes !== 'Docker first-run acceptance'
  ) {
    throw new Error(`persisted entry mismatch: ${JSON.stringify(restoredBody)}`)
  }
  const attachment = await fetch(
    `${origin}/api/v1/projects/${project.id}/attachments/${attachmentBody.data.id}/content`,
    { headers: { cookie } },
  )
  if (
    !attachment.ok ||
    !Buffer.from(await attachment.arrayBuffer()).equals(attachmentBytes)
  ) {
    throw new Error('restored attachment bytes do not match')
  }
  console.log(
    '[e2e:first-run] Docker signup, SMTP verification, and tracking passed',
  )
  console.log(
    '[e2e:backup-restore] exclusive stopped-volume SQLite and attachment restore passed',
  )
} finally {
  await cleanup(smtp, dockerAvailable, temporaryRoot)
}
