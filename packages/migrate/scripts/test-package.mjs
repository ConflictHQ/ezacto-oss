// Clean-machine smoke test for @conflict-hq/ezacto-migrate.
//
//   npm run test:package -w @conflict-hq/ezacto-migrate
//   HARVEST_PAT=... HARVEST_ACCOUNT_ID=... node packages/migrate/scripts/test-package.mjs --live
//
// Packs the package, installs the tarball into an empty prefix with no
// workspace, no development conditions and no developer configuration, and
// drives the installed binary. Two ways in are exercised: the global install
// and `npm exec`, which is what `npx @conflict-hq/ezacto-migrate` runs.
//
// Without --live nothing leaves the machine except npm's own registry traffic
// for the third-party dependencies. With --live the installed binary sweeps the
// Harvest account named by HARVEST_PAT and HARVEST_ACCOUNT_ID into a temporary
// snapshot, verifies it, loads it into a temporary database and reconciles it.
// Only exit codes and the tool's own count lines are printed: never the token,
// and the snapshot and database are deleted when the run ends.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const live = process.argv.includes('--live')
const root = fileURLToPath(new URL('../../..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'ezacto-migrate-package-'))
const prefix = join(directory, 'global')

// Never inherit a developer's Harvest credentials or npm workspace settings.
// --live passes the two it needs back in explicitly.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(NODE_OPTIONS|NODE_PATH|EZACTO_.*|HARVEST_.*|CLOUDFLARE_.*|npm_config_(workspace|workspaces|prefix))$/i.test(
        key,
      ),
  ),
)
const liveEnvironment = { ...environment }
if (live) {
  for (const key of ['HARVEST_PAT', 'HARVEST_ACCOUNT_ID', 'HARVEST_USER_AGENT_EMAIL']) {
    if (process.env[key]) liveEnvironment[key] = process.env[key]
  }
  assert.ok(liveEnvironment.HARVEST_PAT, '--live needs HARVEST_PAT in the environment')
}

const run = (command, args, { cwd = directory, env = environment, allowFailure = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: live ? 3_600_000 : 180_000,
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} exited ${result.status}\n${result.stderr}`)
  }
  return result
}

try {
  const [packed] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--workspace',
        '@conflict-hq/ezacto-migrate',
        '--pack-destination',
        directory,
        '--json',
      ],
      {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: 180_000,
      },
    ),
  )
  const tarball = join(directory, packed.filename)

  // Both entry points are self-contained bundles; no private workspace or source tree rides along.
  assert.deepEqual(
    packed.files
      .map((file) => file.path)
      .filter((path) => path !== 'package.json' && !/^README/i.test(path))
      .sort(),
    ['dist/cli.js', 'dist/queued-loader.js', 'src/queued-loader-api.d.ts'],
  )

  // Never ignore lifecycle scripts: the SQLite native binding is part of the product.
  run('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball])
  const installed = join(prefix, 'lib/node_modules/@conflict-hq/ezacto-migrate')
  assert.ok(realpathSync(installed).startsWith(`${realpathSync(directory)}/`))
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    assert.ok(!name.startsWith('@ezacto/'), `unpublished runtime dependency: ${name}`)
  }
  const workerEntry = run(process.execPath, [
    '--input-type=module',
    '-e',
    'const {deliverQueuedLoad}=await import(' +
      JSON.stringify(new URL('file://' + join(installed, 'dist/queued-loader.js')).href) +
      '); if(typeof deliverQueuedLoad!=="function")process.exit(1)',
  ])
  assert.equal(workerEntry.status, 0)
  const bin = join(prefix, 'bin/ezacto-migrate')

  // The bin symlink runs, and prints its command list (usage exits 1 by design).
  const usage = run(bin, [], { allowFailure: true })
  assert.equal(usage.status, 1)
  assert.match(usage.stdout, /ezacto-migrate <command>/)

  // The npx path: resolve the bin from the tarball in a directory with nothing
  // in it, the way a first-time user would.
  const empty = mkdtempSync(join(directory, 'empty-'))
  const viaNpx = run(
    'npm',
    ['exec', '--yes', '--no-audit', '--no-fund', `--package=${tarball}`, '--', 'ezacto-migrate'],
    { cwd: empty, allowFailure: true },
  )
  assert.equal(viaNpx.status, 1)
  assert.match(viaNpx.stdout, /ezacto-migrate <command>/)

  // Without a token the tool says so and stops, instead of reaching for anything.
  const noToken = run(bin, ['auth', '--snapshot-dir', join(directory, 'none')], {
    allowFailure: true,
  })
  assert.notEqual(noToken.status, 0)
  assert.match(noToken.stderr, /HARVEST_PAT/)

  // The bundled database code and native SQLite binding, through a real
  // database migrated by the workspace's own build: the installed package must
  // agree with the migration ledger it was built from.
  const { default: Database } = await import('better-sqlite3')
  const { migrateContainer } = await import('@ezacto/db')
  const databasePath = join(directory, 'candidate.sqlite')
  const database = new Database(databasePath)
  migrateContainer(database)
  database.close()
  const preflight = run(bin, ['preflight-migrations', '--database', databasePath])
  assert.equal(preflight.status, 0)

  if (live) {
    const snapshot = join(directory, 'snapshot')
    const loaded = join(directory, 'loaded.sqlite')
    const step = (args) => {
      const result = run(bin, args, { env: liveEnvironment, allowFailure: true })
      process.stdout.write(`$ ezacto-migrate ${args[0]}: exit ${result.status}\n`)
      assert.equal(
        result.status,
        0,
        `${args[0]} failed:\n${result.stderr.replaceAll(liveEnvironment.HARVEST_PAT, '[token]')}`,
      )
      return result.stdout
    }
    step(['auth', '--snapshot-dir', snapshot])
    process.stdout.write(step(['extract', '--snapshot-dir', snapshot]))
    step(['verify', '--snapshot-dir', snapshot])
    step(['load', '--snapshot-dir', snapshot, '--database', loaded])
    process.stdout.write(step(['reconcile', '--snapshot-dir', snapshot, '--database', loaded]))
  }

  process.stdout.write(
    `Packed migrate ${manifest.version}: isolated global install, portable Worker import, npx path, ledger preflight${live ? ', live Harvest sweep, load and reconcile' : ''} passed.\n`,
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
