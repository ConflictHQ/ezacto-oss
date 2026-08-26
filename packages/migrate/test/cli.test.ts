// The shipped entrypoint, exercised the way npm installs it: `bin` is linked as a
// symlink (node_modules/.bin, npm link, npx), so the CLI must still run when
// argv[1] is the symlink and not the module realpath.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(pkgDir, 'dist', 'cli.js')

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const runNode = (entry: string): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(process.execPath, [entry], { cwd: pkgDir }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : 0
      resolve({ code, stdout, stderr })
    })
  })

describe('ezacto-migrate CLI entrypoint', () => {
  let dir: string

  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: pkgDir })
  }, 120_000)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-cli-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] prints usage and exits 1 when invoked directly', async () => {
    const { code, stdout } = await runNode(cliPath)

    expect(stdout).toContain('ezacto-migrate <command>')
    expect(code).toBe(1)
  })

  it('[unit] does the same through a bin symlink — the installed shape is not a silent no-op', async () => {
    const link = join(dir, 'ezacto-migrate')
    await symlink(cliPath, link)

    const { code, stdout } = await runNode(link)

    expect(stdout).toContain('ezacto-migrate <command>')
    expect(code).toBe(1)
  })
})
