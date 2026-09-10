// The shipped entrypoint, exercised the way npm installs it: `bin` is linked as a
// symlink (node_modules/.bin, npm link, npx), so the CLI must still run when
// argv[1] is the symlink and not the module realpath.

import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { formatCounts } from '../src/cli.js'
import { findDevVars } from '../src/env.js'
import { resourceProgress } from './fixtures.js'

const execFileAsync = promisify(execFile)
const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(pkgDir, 'dist', 'cli.js')
const tscPath = join(pkgDir, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc')

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const runNode = (
  entry: string,
  args: string[] = [],
  opts: { cwd?: string } = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    // the shipped CLI must never depend on the developer's own credentials
    const env = { ...process.env }
    delete env.HARVEST_PAT
    execFile(
      process.execPath,
      [entry, ...args],
      { cwd: opts.cwd ?? pkgDir, env },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : 0
        resolve({ code, stdout, stderr })
      },
    )
  })

describe('ezacto-migrate CLI entrypoint', () => {
  let dir: string

  beforeAll(async () => {
    // The shipped CLI resolves its imports to its dependencies' shipped output,
    // so this is only the real entrypoint if that output exists: migrate needs
    // @ezacto/db and @ezacto/core, db needs core and @ezacto/mailer, mailer
    // needs core. Built in that order. Building only this package left the
    // suite passing on whatever dist an earlier build happened to leave behind,
    // and failing on a clean checkout.
    for (const name of ['core', 'mailer', 'db']) {
      await execFileAsync(process.execPath, [tscPath, '-p', 'tsconfig.build.json'], {
        cwd: join(pkgDir, '..', name),
      })
    }
    await execFileAsync(process.execPath, [tscPath, '-p', 'tsconfig.build.json'], { cwd: pkgDir })
  }, 240_000)

  beforeEach(async () => {
    // realpath: on macOS the child's process.cwd() reports /private/var/…,
    // and these tests compare the CLI's output against this path
    dir = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-migrate-cli-')))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] prints usage and exits 1 when invoked directly', async () => {
    const { code, stdout } = await runNode(cliPath)

    expect(stdout).toContain('ezacto-migrate <command>')
    expect(code).toBe(1)
  })

  it('[unit] lists every command it can actually dispatch', async () => {
    const { stdout } = await runNode(cliPath)

    // A command in the usage text that the dispatcher does not handle would print
    // usage and exit 1 — advertised and broken.
    expect(stdout).toContain('auth')
    expect(stdout).toContain('extract')
    expect(stdout).toContain('sync')
    expect(stdout).toContain('verify')
    expect(stdout).toContain('load')
    expect(stdout).toContain('reconcile')
    expect(stdout).toContain('preflight-migrations')
    expect(stdout).toContain('finish-retainers')
    expect(stdout).toContain('finish-recurring-invoices')
  })

  it('[security #468] runs the cutover preflight without Harvest credentials', async () => {
    const input = join(dir, 'ledger.json')
    await writeFile(input, JSON.stringify([{ success: true, results: [] }]))
    const { code, stderr } = await runNode(cliPath, ['preflight-migrations', '--input', input], { cwd: dir })
    expect(code).toBe(1)
    expect(stderr).toContain('cutover_migration_ledger_mismatch')
    expect(stderr).not.toContain('HARVEST_PAT')
  })

  it('[unit] reconcile is offline and requires only the snapshot and database paths', async () => {
    const { code, stderr } = await runNode(cliPath, ['reconcile', '--snapshot-dir', dir], {
      cwd: dir,
    })

    expect(stderr).toContain('--database is required for reconcile')
    expect(stderr).not.toContain('HARVEST_PAT')
    expect(code).toBe(1)
  })

  it.each(['finish-retainers', 'finish-recurring-invoices'])(
    '[unit] %s is offline and requires only snapshot, database, and optional input paths',
    async (command) => {
      const { code, stderr } = await runNode(cliPath, [command, '--snapshot-dir', dir], {
        cwd: dir,
      })

      expect(stderr).toContain(`--database is required for ${command}`)
      expect(stderr).not.toContain('HARVEST_PAT')
      expect(code).toBe(1)
    },
  )

  it('[unit] advertises the resume and incremental behavior extract now has', async () => {
    const { stdout } = await runNode(cliPath)

    expect(stdout).toContain('resumes an interrupted resource from its last checkpoint')
  })

  it('[unit] extract refuses a snapshot dir auth has never stamped', async () => {
    await writeFile(join(dir, '.dev.vars'), 'HARVEST_PAT=fake\n')

    const { code, stderr } = await runNode(cliPath, ['extract', '--snapshot-dir', dir], {
      cwd: dir,
    })

    // Fails on the missing manifest, before spending a request on a bad token.
    expect(stderr).toContain('ezacto-migrate auth')
    expect(code).toBe(1)
  })

  it('[unit] does the same through a bin symlink — the installed shape is not a silent no-op', async () => {
    const link = join(dir, 'ezacto-migrate')
    await symlink(cliPath, link)

    const { code, stdout } = await runNode(link)

    expect(stdout).toContain('ezacto-migrate <command>')
    expect(code).toBe(1)
  })

  // migration-spec §1 ships this as a standalone published CLI: for every user
  // who is not sitting in the ezacto repo, a module-relative .dev.vars lookup
  // resolves to <prefix>/lib/.dev.vars and the named fix is a file the tool will
  // never read. AC #1 requires the error to name a fix that works.
  it('[unit] with no .dev.vars anywhere, the error names the file to create in the working dir', async () => {
    expect(findDevVars(dir)).toBeNull() // guard: nothing above the temp dir either

    const { code, stderr } = await runNode(cliPath, ['auth'], { cwd: dir })

    expect(stderr).toContain('HARVEST_PAT')
    expect(stderr).toContain(join(dir, '.dev.vars'))
    expect(code).toBe(1)
  })

  // A page of 2000 time entries carries fully embedded assignment objects, so the
  // ten-second default is tight on a slow link — and before this flag the only
  // remedy for a page that would not finish in time was not running extract.
  it('[unit] --request-timeout is rejected when it is not a positive number of seconds', async () => {
    await writeFile(join(dir, '.dev.vars'), 'HARVEST_PAT=t\n')

    const { code, stderr } = await runNode(cliPath, ['extract', '--request-timeout', 'soon'], {
      cwd: dir,
    })

    expect(stderr).toContain('--request-timeout must be a positive number of seconds, got "soon"')
    expect(code).toBe(1)
  })

  it('[unit] loads .dev.vars from the working directory, not from the installed module', async () => {
    // no HARVEST_PAT in it: the error proves which file was read, without a token
    const devVars = join(dir, '.dev.vars')
    await writeFile(devVars, 'HARVEST_USER_AGENT_EMAIL=user@example.com\n')

    const { code, stderr } = await runNode(cliPath, ['auth'], { cwd: dir })

    expect(stderr).toContain(`add HARVEST_PAT=<token> to ${devVars}`)
    expect(code).toBe(1)
  })
})

describe('the extract counts table', () => {
  it('[unit] prints a row per resource, aligned, with skips called out and a total', () => {
    const table = formatCounts(
      {
        resources: {
          users: resourceProgress({ count: 12, pages: 1 }),
          time_entries: resourceProgress({ count: 48213, pages: 25 }),
          estimates: resourceProgress({ skipped_reason: 'estimate_feature is false' }),
        },
        requests: 27,
        durationMs: 61_400,
      },
      '/snap/manifest.json',
    )

    const lines = table.split('\n')
    // Column alignment is what makes a spot-check against the Harvest UI readable.
    expect(lines[0]).toBe('users              12 rows     1 pages')
    expect(lines[1]).toBe('time_entries    48213 rows    25 pages')
    // A zero that is *explained* must not read like a zero that is a bug.
    expect(lines[2]).toBe(
      'estimates           0 rows     0 pages  skipped: estimate_feature is false',
    )
    expect(lines[4]).toBe('total: 48225 rows, 27 requests, 61s')
    expect(lines[5]).toBe('manifest: /snap/manifest.json')
  })

  // A resource that came back short prints as an ordinary number otherwise, and
  // this table is what a Harvest UI spot-check is compared against.
  it('[unit] says when a count is short of the account, not just what was written', () => {
    const table = formatCounts(
      {
        resources: {
          time_entries: resourceProgress({ count: 1, pages: 1, total_entries: 4000 }),
          invoice_messages: resourceProgress({ count: 55, pages: 55, missing_parents: 2 }),
        },
        requests: 60,
        durationMs: 10_000,
      },
      '/snap/manifest.json',
    )

    const lines = table.split('\n')
    expect(lines[0]).toContain('Harvest reported 4000')
    expect(lines[1]).toContain('2 parents missing')
  })

  // `total_entries` freezes at the last full sweep's tally while `count` keeps
  // growing across `updated_since` passes, so comparing the two after a re-run
  // reported a Harvest discrepancy for every resource with any activity at all —
  // extract itself says nothing, because it guards the same comparison. A table
  // that cries wolf on every row is how a real shortfall stops being visible.
  it('[unit] an incremental pass is measured against its own tally, not the last full sweep', () => {
    const table = formatCounts(
      {
        resources: {
          // two rows from the full sweep, two more merged in by the pass that
          // followed it — and the pass got every changed row it was told about
          time_entries: resourceProgress({
            count: 4,
            pages: 1,
            total_entries: 2,
            staged_count: 2,
            staged_total_entries: 2,
            incremental: true,
          }),
          // the pass that did not: five changed rows stated, two handed over
          expenses: resourceProgress({
            count: 4,
            pages: 1,
            total_entries: 2,
            staged_count: 2,
            staged_total_entries: 5,
            incremental: true,
          }),
        },
        requests: 2,
        durationMs: 1_000,
      },
      '/snap/manifest.json',
    )

    const lines = table.split('\n')
    expect(lines[0]).toBe('time_entries        4 rows     1 pages')
    expect(lines[1]).toContain('Harvest reported 5 changed, this pass staged 2')
  })
})
