import { build } from 'esbuild'
import { mkdir, writeFile, symlink, rm, readFile, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
const repository = resolve(import.meta.dirname, '../../..')
const fixture = process.env.EZACTO_STRIPE_FIXTURE_DIRECTORY
const assertOwned = async () => {
  if (!fixture || await realpath(fixture) !== fixture || dirname(fixture) !== await realpath(tmpdir()) || !basename(fixture).startsWith('ezacto-owned-stripe-browser-') || !process.env.EZACTO_STRIPE_FIXTURE_NONCE || await readFile(join(fixture, '.owned-browser-fixture'), 'utf8') !== process.env.EZACTO_STRIPE_FIXTURE_NONCE) throw new Error('Refusing an unowned Stripe browser fixture directory')
}
await assertOwned()
const output = join(fixture, 'runtime')
await mkdir(output, { mode: 0o700 })
await writeFile(join(output, 'package.json'), '{"type":"module"}', { mode: 0o600 })
await symlink(join(repository, 'node_modules'), join(output, 'node_modules'), 'dir')
await build({ entryPoints: [join(repository, 'apps/web/test/support/stripe-container-native-entry.mjs')], bundle: true, conditions: ['development'], platform: 'node', format: 'esm', target: 'node22', outdir: output, external: ['better-sqlite3', 'nodemailer'], logLevel: 'warning' })
const child = spawn(process.execPath, [join(output, 'stripe-container-native-entry.js')], { env: process.env, stdio: 'inherit' })
let stopping = false
const stop = () => { if (!stopping) { stopping = true; child.kill('SIGTERM') } }
process.once('SIGTERM', stop); process.once('SIGINT', stop)
child.once('exit', async (code, signal) => { await assertOwned(); await rm(fixture, { recursive: true, force: true }); process.exitCode = signal ? 1 : code ?? 1 })
