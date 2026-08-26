// ezacto-migrate ships as a standalone published CLI (migration-spec §1): the
// user is not sitting in the ezacto repo, so .dev.vars must be found from their
// working directory. Resolving it relative to the installed module points at
// <prefix>/lib/.dev.vars for a global install — a file no user will ever create,
// which made the "set HARVEST_PAT in .dev.vars" error name an unusable fix.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findDevVars, loadDevVars, readHarvestEnv } from '../src/env.js'

describe('.dev.vars discovery', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-env-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] finds .dev.vars in the working directory itself', async () => {
    await writeFile(join(dir, '.dev.vars'), 'HARVEST_USER_AGENT_EMAIL=a@b.com\n')

    expect(findDevVars(dir)).toBe(join(dir, '.dev.vars'))
  })

  it('[unit] walks up from a subdirectory, nearest file winning', async () => {
    const nested = join(dir, 'packages', 'migrate')
    await mkdir(nested, { recursive: true })
    await writeFile(join(dir, '.dev.vars'), 'HARVEST_USER_AGENT_EMAIL=root@b.com\n')

    expect(findDevVars(nested)).toBe(join(dir, '.dev.vars'))

    await writeFile(join(nested, '.dev.vars'), 'HARVEST_USER_AGENT_EMAIL=near@b.com\n')
    expect(findDevVars(nested)).toBe(join(nested, '.dev.vars'))
  })

  it('[unit] returns null when no .dev.vars exists above the directory', () => {
    expect(findDevVars(join(dir, 'no', 'such', 'place'))).toBeNull()
  })

  it('[unit] loadDevVars reads the Harvest variables it found into the environment', async () => {
    await writeFile(join(dir, '.dev.vars'), 'HARVEST_USER_AGENT_EMAIL=loaded@example.com\n')
    const before = process.env.HARVEST_USER_AGENT_EMAIL
    delete process.env.HARVEST_USER_AGENT_EMAIL

    try {
      expect(loadDevVars(dir)).toBe(join(dir, '.dev.vars'))
      expect(process.env.HARVEST_USER_AGENT_EMAIL).toBe('loaded@example.com')
    } finally {
      if (before === undefined) delete process.env.HARVEST_USER_AGENT_EMAIL
      else process.env.HARVEST_USER_AGENT_EMAIL = before
    }
  })

  // The search walks up to `/`, so the file it finds is not necessarily one this
  // user wrote: a cloned repo, an unpacked tarball, a shared working tree or a
  // planted ~/.dev.vars all sit on the path of an ordinary `extract`. Handed to
  // process.loadEnvFile the whole file became this process's environment, and Node
  // reads some of its own variables lazily — `NODE_TLS_REJECT_UNAUTHORIZED=0` in a
  // directory above the user turned off certificate verification for every request
  // the CLI then made, each of which carries the account's PAT by construction.
  it('[unit] a .dev.vars cannot set anything but the Harvest variables', async () => {
    await writeFile(
      join(dir, '.dev.vars'),
      'HARVEST_PAT=from-file\nNODE_TLS_REJECT_UNAUTHORIZED=0\nEZACTO_MIGRATE_ENV_TEST=loaded\n',
    )
    const beforePat = process.env.HARVEST_PAT
    delete process.env.HARVEST_PAT

    try {
      expect(loadDevVars(dir)).toBe(join(dir, '.dev.vars'))
      // the key it exists to carry, and nothing beside it
      expect(process.env.HARVEST_PAT).toBe('from-file')
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
      expect(process.env.EZACTO_MIGRATE_ENV_TEST).toBeUndefined()
    } finally {
      if (beforePat === undefined) delete process.env.HARVEST_PAT
      else process.env.HARVEST_PAT = beforePat
    }
  })

  // process.loadEnvFile left an already-exported variable alone, and the error
  // surface below still names .dev.vars as the place to put a missing one — so a
  // shell export must keep winning over the file.
  it('[unit] a shell-exported value still wins over the file', async () => {
    await writeFile(join(dir, '.dev.vars'), 'HARVEST_ACCOUNT_ID=from-file\n')
    const before = process.env.HARVEST_ACCOUNT_ID
    process.env.HARVEST_ACCOUNT_ID = 'from-shell'

    try {
      loadDevVars(dir)
      expect(process.env.HARVEST_ACCOUNT_ID).toBe('from-shell')
    } finally {
      if (before === undefined) delete process.env.HARVEST_ACCOUNT_ID
      else process.env.HARVEST_ACCOUNT_ID = before
    }
  })
})

describe('readHarvestEnv error surface', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.HARVEST_PAT
    delete process.env.HARVEST_PAT
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.HARVEST_PAT
    else process.env.HARVEST_PAT = saved
  })

  it('[unit] names the .dev.vars file that was actually loaded', () => {
    const path = join('/somewhere', 'userproj', '.dev.vars')

    expect(() => readHarvestEnv(path)).toThrow(path)
    expect(() => readHarvestEnv(path)).toThrow('HARVEST_PAT')
  })

  it('[unit] with no .dev.vars, names the file to create in the working directory', () => {
    expect(() => readHarvestEnv(null)).toThrow(join(process.cwd(), '.dev.vars'))
    expect(() => readHarvestEnv(null)).toThrow('export HARVEST_PAT')
  })
})
