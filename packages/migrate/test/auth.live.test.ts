import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAuth } from '../src/auth.js'

const hasLiveCreds = Boolean(process.env.HARVEST_PAT && process.env.HARVEST_ACCOUNT_ID)

describe.skipIf(!hasLiveCreds)('runAuth [manual/api] against the live CONFLICT account', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-auth-live-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves the configured account and confirms administrator access', async () => {
    const result = await runAuth({
      env: {
        pat: process.env.HARVEST_PAT as string,
        accountId: process.env.HARVEST_ACCOUNT_ID,
        userAgentEmail: process.env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
      },
      toolVersion: '0.0.0',
      snapshotDir: dir,
    })

    expect(result.account.id).toBe(process.env.HARVEST_ACCOUNT_ID)
    expect(result.isAdministrator).toBe(true)
  })
})
