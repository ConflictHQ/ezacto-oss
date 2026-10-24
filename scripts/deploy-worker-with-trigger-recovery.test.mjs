import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { deployWorker, recoverableQueueTriggerFailure } from './deploy-worker-with-trigger-recovery.mjs'

const endpoint = `/accounts/${'a'.repeat(32)}/queues/${'b'.repeat(32)}/consumers/${'c'.repeat(32)}`
const partial = `Trigger configuration for "synthetic-worker" was only partially updated:

  Queue consumers:
    - A request to the Cloudflare API (${endpoint}) failed.
      - An unknown error has occurred. If this error persists, please file a report in workers-sdk. [code: 10013]

Successful trigger changes were not rolled back.`
const args = ['--env', 'prod', '--var', 'RELEASE:synthetic', '--outdir', '/tmp/synthetic-bundle']
const result = (status, output = '', signal = null) => ({ status, output, signal })

async function scenario(responses, deployArgs = args) {
  const calls = [], pauses = [], messages = []
  const status = await deployWorker(deployArgs, {
    run: async command => { calls.push(command); return responses.shift() },
    pause: async milliseconds => { pauses.push(milliseconds) },
    report: message => messages.push(message),
  })
  return { status, calls, pauses, messages }
}

test('only a queue-only partial consumer 10013 matches, including ANSI output', () => {
  assert.equal(recoverableQueueTriggerFailure(partial), true)
  assert.equal(recoverableQueueTriggerFailure(`\u001b[31m${partial}\u001b[0m`), true)
  for (const other of [
    '[code: 10013]',
    partial.replace('Queue consumers:', 'Routes:'),
    partial.replace('/consumers/', '/messages/'),
    partial.replace('[code: 10013]', '[code: 10000]'),
    partial.replace('Successful trigger changes were not rolled back.', ''),
    partial.replace('Successful trigger changes were not rolled back.', '  Workflows:\n    - permission denied\nSuccessful trigger changes were not rolled back.'),
    `${partial}\n${partial}`,
  ]) assert.equal(recoverableQueueTriggerFailure(other), false, other)
})

test('an ordinary success uploads code once and needs no recovery', async () => {
  const outcome = await scenario([result(0)])
  assert.equal(outcome.status, 0)
  assert.deepEqual(outcome.calls, [['deploy', ...args]])
  assert.deepEqual(outcome.pauses, [])
})

test('the observed partial failure retries triggers once with the same env, never code or vars', async () => {
  for (const environment of ['dev', 'prod']) {
    const supplied = ['--env', environment, ...args.slice(2)]
    const outcome = await scenario([result(1, partial), result(0)], supplied)
    assert.equal(outcome.status, 0)
    assert.deepEqual(outcome.calls, [['deploy', ...supplied], ['triggers', 'deploy', '--env', environment]])
    assert.deepEqual(outcome.pauses, [5_000])
    assert.match(outcome.messages.at(-1), /binding.*smoke checks must still pass/u)
  }
})

test('a second partial failure stops nonzero and names the partial live state', async () => {
  const outcome = await scenario([result(1, partial), result(7, partial)])
  assert.equal(outcome.status, 7)
  assert.equal(outcome.calls.length, 2)
  assert.match(outcome.messages.at(-1), /may already be live.*partially updated.*not rolled back.*No further retry/u)
})

test('other deployment failures or interruption are never retried', async () => {
  for (const failure of [result(2, 'authentication failed'), result(3, '[code: 10013]'), result(null, partial, 'SIGTERM')]) {
    const outcome = await scenario([failure])
    assert.equal(outcome.status, failure.status || 1)
    assert.equal(outcome.calls.length, 1)
    assert.deepEqual(outcome.pauses, [])
  }
  const mixed = await scenario([result(4, partial.replace('Queue consumers:', 'Workflows:'))])
  assert.match(mixed.messages.at(-1), /No automatic recovery matched/u)
})

test('unknown target overrides stop before deployment instead of recovering another Worker', async () => {
  for (const supplied of [[], ['--env', 'preview'], [...args, '--name', 'another-worker'], [...args, '--config', '/tmp/other.jsonc']]) {
    let called = false
    await assert.rejects(deployWorker(supplied, { run: async () => { called = true } }))
    assert.equal(called, false)
  }
})

test('the executable wrapper preserves exit status without exposing or shell-evaluating arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ezacto-trigger-wrapper-'))
  try {
    const executable = join(root, 'npx'), commands = join(root, 'commands.json')
    await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs'
fs.writeFileSync(process.env.SYNTHETIC_COMMAND_FILE, JSON.stringify(process.argv.slice(2)))
process.exit(9)
`, { mode: 0o700 })
    const supplied = ['--env', 'dev', '--var', 'RELEASE:$(must-remain-literal)']
    const run = spawnSync(process.execPath, [new URL('./deploy-worker-with-trigger-recovery.mjs', import.meta.url).pathname, ...supplied], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SYNTHETIC_COMMAND_FILE: commands }, encoding: 'utf8',
    })
    assert.equal(run.status, 9)
    assert.deepEqual(JSON.parse(await readFile(commands, 'utf8')), ['--no-install', 'wrangler', 'deploy', ...supplied])
    assert.equal(run.stdout, '')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the executable recovers a real failed child once using only the trigger command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ezacto-trigger-recovery-'))
  try {
    const commands = join(root, 'commands.jsonl')
    await writeFile(join(root, 'npx'), `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SYNTHETIC_COMMAND_FILE, JSON.stringify(args) + '\\n')
if (args[2] === 'deploy') {
  process.stderr.write(${JSON.stringify(partial)})
  process.exit(1)
}
process.exit(args[2] === 'triggers' ? 0 : 8)
`, { mode: 0o700 })
    const supplied = ['--env', 'dev', '--var', 'RELEASE:synthetic']
    const run = spawnSync(process.execPath, [new URL('./deploy-worker-with-trigger-recovery.mjs', import.meta.url).pathname, ...supplied], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SYNTHETIC_COMMAND_FILE: commands }, encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual((await readFile(commands, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [
      ['--no-install', 'wrangler', 'deploy', ...supplied],
      ['--no-install', 'wrangler', 'triggers', 'deploy', '--env', 'dev'],
    ])
    assert.match(run.stderr, /Trigger-only recovery succeeded/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
