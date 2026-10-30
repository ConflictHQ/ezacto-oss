import { build } from 'esbuild'
import { mkdir, writeFile, symlink, rm, readFile, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const repository = resolve(import.meta.dirname, '../../..')
const fixture = process.env.EZACTO_STAFF_CODE_FIXTURE_DIRECTORY
if (!fixture || !process.env.EZACTO_STAFF_CODE_FIXTURE_PASSWORD) throw new Error('Owned STAFF_CODE fixture configuration is missing')
const assertOwned = async () => {
  if (await realpath(fixture) !== fixture || dirname(fixture) !== await realpath(tmpdir()) || !basename(fixture).startsWith('ezacto-owned-staff-code-browser-') || !process.env.EZACTO_STAFF_CODE_FIXTURE_NONCE || await readFile(join(fixture, '.owned-browser-fixture'), 'utf8') !== process.env.EZACTO_STAFF_CODE_FIXTURE_NONCE) throw new Error('Refusing an unowned STAFF_CODE browser fixture directory')
}
await assertOwned()
const output = join(fixture, 'runtime')
await mkdir(output, { mode: 0o700 })
await writeFile(join(output, 'package.json'), '{"type":"module"}', { mode: 0o600 })
await symlink(join(repository, 'node_modules'), join(output, 'node_modules'), 'dir')
await build({
  entryPoints: {
    'staff-code-container-native-entry': join(repository, 'apps/web/test/support/staff-code-container-native-entry.mjs'),
    'csv-staging-worker': join(repository, 'entries/container/src/csv-staging-worker.ts'),
  },
  bundle: true, conditions: ['development'], platform: 'node', format: 'esm', target: 'node22',
  outdir: output, external: ['better-sqlite3', 'nodemailer'], logLevel: 'warning',
})
if (process.env.EZACTO_STAFF_CODE_MOBILE_SOURCE) {
  const source = await realpath(process.env.EZACTO_STAFF_CODE_MOBILE_SOURCE)
  await build({
    stdin: { contents: `import * as client from ${JSON.stringify(source)}; globalThis.ownedMobileClient = client;`, resolveDir: dirname(source), sourcefile: 'owned-mobile-entry.js' },
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', tsconfigRaw: { compilerOptions: {} },
    alias: { '@conflict-hq/ezacto-client': join(repository, 'packages/client/src/index.ts') },
    outfile: join(output, 'mobile-client.js'), logLevel: 'warning',
  })
}
const child = spawn(process.execPath, [join(output, 'staff-code-container-native-entry.js')], { env: process.env, stdio: 'inherit' })
let stopping = false
const stop = () => { if (!stopping) { stopping = true; child.kill('SIGTERM') } }
process.once('SIGTERM', stop); process.once('SIGINT', stop)
child.once('exit', async (code, signal) => {
  await assertOwned()
  await rm(fixture, { recursive: true, force: true })
  process.exitCode = signal ? 1 : code ?? 1
})
