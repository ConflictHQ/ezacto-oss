import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const help = run(ez, ['--help'])
  assert.match(help, /ez <command>/)
  assert.match(help, /backup-decrypt/)

  // Write the documented V1 format with Node's cipher API, independently of
  // the WebCrypto implementation embedded in the installed command.
  const encrypted = join(directory, 'encrypted-logical-run')
  const decrypted = join(directory, 'decrypted-logical-run')
  mkdirSync(join(encrypted, 'tables'), {recursive:true})
  const encryptionKey = randomBytes(32)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const csv = Buffer.from('id,note\n1,packed decryption\n')
  const logicalManifest = {schema_version:1,table_count:1,total_rows:1,tables:{package_smoke:{sha256:digest(csv)}}}
  for (const [name,bytes] of [
    ['tables/package_smoke.csv',csv],
    ['RESTORE.md',Buffer.from('Logical bundle recovery instructions')],
    ['manifest.json',Buffer.from(JSON.stringify(logicalManifest))],
  ]) {
    const nonce = randomBytes(12)
    const header = Buffer.from(JSON.stringify({version:1,name,sha256:digest(bytes),nonce:nonce.toString('base64url'),key_id:digest(encryptionKey).slice(0,32)}))
    const cipher = createCipheriv('aes-256-gcm',encryptionKey,nonce)
    cipher.setAAD(header)
    const payload = Buffer.concat([cipher.update(bytes),cipher.final(),cipher.getAuthTag()])
    writeFileSync(join(encrypted,name+'.ezenc'),Buffer.concat([Buffer.from('EZACTO-BACKUP-AES256GCM-V1\n'),header,Buffer.from('\n'),payload]))
  }
  environment.EZACTO_BACKUP_ENCRYPTION_KEY = encryptionKey.toString('base64url')
  const decryption = JSON.parse(run(ez,['backup-decrypt',encrypted,'--output',decrypted,'--json']))
  delete environment.EZACTO_BACKUP_ENCRYPTION_KEY
  assert.equal(decryption.tableCount,1)
  assert.deepEqual(readFileSync(join(decrypted,'tables/package_smoke.csv')),csv)
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
  process.stdout.write(`Packed CLI ${manifest.version}: isolated global install, reports, decryption, and SQLite backup passed.\n`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
