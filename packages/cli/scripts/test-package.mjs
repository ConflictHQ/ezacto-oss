import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'ezacto-cli-package-'))
const prefix = join(directory, 'global')
// Exercise Node's normal package resolution, without development conditions,
// workspace configuration, credentials, or a developer's CLI configuration.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(NODE_OPTIONS|NODE_PATH|EZACTO_.*|npm_config_(workspace|workspaces|prefix))$/i.test(key),
))
environment.EZACTO_CONFIG = join(directory, 'config.json')
const run = (command, args, cwd = directory) => execFileSync(command, args, {
  cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  timeout: 180_000,
})

try {
  const tarballs = ['@conflict-hq/ezacto-client', '@conflict-hq/ezacto-cli'].map((name) => {
    const [packed] = JSON.parse(run('npm', [
      'pack', '--workspace', name, '--pack-destination', directory, '--json',
    ], root))
    return join(directory, packed.filename)
  })
  // Install the two release candidates together: the client version is not on
  // npm yet. All other production dependencies must resolve normally. Never
  // ignore lifecycle scripts: the SQLite native binding is part of the product.
  run('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', ...tarballs])
  const cliDirectory = join(prefix, 'lib/node_modules/@conflict-hq/ezacto-cli')
  assert.ok(realpathSync(cliDirectory).startsWith(`${realpathSync(directory)}/`))
  const manifest = JSON.parse(readFileSync(join(cliDirectory, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    assert.ok(!name.startsWith('@ezacto/'), `unpublished runtime dependency: ${name}`)
  }
  const ez = join(prefix, 'bin/ez')
  assert.match(run(ez, ['--help']), /ez <command>/)
  const reports = JSON.parse(run(ez, ['report', 'list', '--json']))
  assert.ok(reports.includes('my-hours'))
  assert.ok(reports.includes('project-budget'))
  assert.match(run(ez, ['report', 'list']), /project-budget \(requires projects:read\)/)

  // Open a real database through the installed package's native dependency,
  // then drive its backup command through the global bin symlink.
  const fixture = join(directory, 'fixture.cjs')
  writeFileSync(fixture, `
    const { createRequire } = require('node:module')
    const installedRequire = createRequire(${JSON.stringify(join(cliDirectory, 'package.json'))})
    const Database = installedRequire('better-sqlite3')
    const db = new Database('fixture.sqlite')
    db.exec("CREATE TABLE package_smoke (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO package_smoke VALUES (1, 'packed install')")
    db.close()
  `)
  run(process.execPath, [fixture])
  const backup = JSON.parse(run(ez, [
    'backup', '--database', resolve(directory, 'fixture.sqlite'), '--output', directory, '--json',
  ]))
  assert.equal(backup.tables, 1)
  assert.equal(backup.rows, 1)
  assert.match(readFileSync(join(backup.bundle, 'tables/package_smoke.csv'), 'utf8'), /packed install/)
  process.stdout.write(`Packed CLI ${manifest.version}: isolated global install, reports, and SQLite backup passed.\n`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
