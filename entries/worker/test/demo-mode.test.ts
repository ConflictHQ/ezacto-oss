import { describe, expect, it } from 'vitest'
import { createApp, demoDeployment, publishedDemoAccounts, type AppEnv } from '../src/app.js'
import { runDemoMaintenance } from '../src/demo.js'
import { demoAccounts } from '@ezacto/db/d1'

const app = createApp()
const base: AppEnv = { ENVIRONMENT: 'dev', RELEASE: 'abc1234' }
const demo: AppEnv = { ...base, DEMO_MODE: 'true' }

/**
 * An env whose database binding throws on the first touch. Reaching it at all
 * is the bug the wipe tests exist to catch, so the assertion is the getter.
 */
const envRefusingItsDatabase = (overrides: Partial<AppEnv>) =>
  Object.defineProperty({ ...base, ...overrides }, 'DB', {
    get(): never {
      throw new Error('demo maintenance reached the database it should have refused')
    },
  }) as AppEnv & { DB: D1Database }

describe('demo deployment', () => {
  it('[security] is off unless the environment says so as well as the flag', () => {
    // DEMO_MODE is an operator's switch and ENVIRONMENT is the deployment's
    // identity. A flag copied into a production worker's vars -- which is how
    // this goes wrong -- publishes nothing and wipes nothing.
    expect(demoDeployment(demo)).toBe(true)
    expect(demoDeployment({ ...demo, ENVIRONMENT: 'prod' })).toBe(false)
    expect(demoDeployment(base)).toBe(false)
    expect(demoDeployment({ ...base, DEMO_MODE: 'yes' })).toBe(false)
  })

  it('[security] prints credentials on the sign-in page only where it is the demo', async () => {
    const published = await (await app.request('/', {}, demo)).text()
    for (const account of demoAccounts) {
      expect(published).toContain(account.email)
      expect(published).toContain(account.password)
    }

    // Every other deployment. A password in the HTML of an instance holding
    // someone's books is the whole of the risk this feature carries.
    for (const env of [base, { ...demo, ENVIRONMENT: 'prod' }]) {
      const html = await (await app.request('/', {}, env)).text()
      expect(html).not.toContain('data-demo-credentials')
      for (const account of demoAccounts) {
        expect(html).not.toContain(account.password)
      }
    }
  })

  it('[security] wipes nothing on a deployment that is not the demo', async () => {
    // The env is rigged so that touching the database throws. Reaching it at
    // all is the failure, whichever cron fired.
    for (const cron of ['0 3 * * *', '* * * * *']) {
      expect(
        await runDemoMaintenance(
          envRefusingItsDatabase({ ENVIRONMENT: 'prod', DEMO_MODE: 'true' }),
          cron,
        ),
      ).toEqual({ ran: 'nothing' })
      expect(
        await runDemoMaintenance(envRefusingItsDatabase({ ENVIRONMENT: 'dev' }), cron),
      ).toEqual({ ran: 'nothing' })
    }
  })

  it('[unit] offers each published account with something to tell them apart', () => {
    // Two accounts rather than one, because what a demo is for is showing what
    // each profile can see. Identical descriptions would make the choice noise.
    const accounts = publishedDemoAccounts(demo)
    expect(accounts).toHaveLength(2)
    expect(new Set(accounts!.map((account) => account.describes)).size).toBe(2)
    expect(publishedDemoAccounts(base)).toBeUndefined()
  })
})
