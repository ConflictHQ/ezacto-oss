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

  it('[unit] loadDevVars reads the file it found into the environment', async () => {
    const key = 'EZACTO_MIGRATE_ENV_TEST'
    await writeFile(join(dir, '.dev.vars'), `${key}=loaded\n`)
    const before = process.env[key]

    try {
      expect(loadDevVars(dir)).toBe(join(dir, '.dev.vars'))
      expect(process.env[key]).toBe('loaded')
    } finally {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
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
