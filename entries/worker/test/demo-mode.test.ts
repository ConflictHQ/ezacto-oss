import { describe, expect, it } from 'vitest'
import {
  createApp,
  demoDeployment,
  demoMailDomains,
  publishedDemoAccounts,
  type AppEnv,
} from '../src/app.js'
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

  it('[reliability] bills the demo on the minute cron only, not the hourly one too', async () => {
    // Both fire on the hour. Billing on each started two ticks on the same
    // backlog, which raced every night (EZACTO-SERVER-9/C/E/A/B/D).
    expect(
      await runDemoMaintenance(envRefusingItsDatabase({ ENVIRONMENT: 'dev', DEMO_MODE: 'true' }), '0 * * * *'),
    ).toEqual({ ran: 'nothing' })
  })

  it('[unit] marks every page it serves as the demo, and no other deployment’s', async () => {
    // Issue #931: the screens read this to say what the demo refuses before a
    // click rather than after. Presentation only; the routes refuse either way.
    for (const path of ['/', '/settings/company', '/invoices/INV-1']) {
      expect(await (await app.request(path, {}, demo)).text()).toContain(' data-demo-deployment')
      for (const env of [base, { ...demo, ENVIRONMENT: 'prod' }]) {
        expect(await (await app.request(path, {}, env)).text()).not.toContain(
          'data-demo-deployment',
        )
      }
    }
  })

  it('[security] reads the domains its mail may reach only where it is the demo', () => {
    // Issue 931. Exact domains, lower case, each once; a stray `@` or space in
    // the deployment variable is not a different domain.
    expect(
      demoMailDomains({
        ...demo,
        DEMO_MAIL_ALLOWED_DOMAINS: ' Example.COM, @example.org,,example.com ',
      }),
    ).toEqual(['example.com', 'example.org'])
    // Unset or blank on the demo is no domain at all: it emails nobody.
    expect(demoMailDomains(demo)).toEqual([])
    expect(demoMailDomains({ ...demo, DEMO_MAIL_ALLOWED_DOMAINS: ' , ' })).toEqual([])
    // Anywhere else the variable is not read, whatever it says.
    for (const env of [base, { ...demo, ENVIRONMENT: 'prod' }]) {
      expect(demoMailDomains({ ...env, DEMO_MAIL_ALLOWED_DOMAINS: 'example.com' })).toBeNull()
    }
  })

  it('[security] tells the demo\'s pages that its mail is restricted, never to whom', async () => {
    // Issue 931. A page that named the approved domains would tell every
    // visitor where the demo can send; the screens need only the fact.
    const listed = { ...demo, DEMO_MAIL_ALLOWED_DOMAINS: 'Zq7-Approved.example, @zq7-other.example' }
    const named = (html: string): string[] =>
      ['zq7-approved.example', 'zq7-other.example'].filter((domain) =>
        html.toLowerCase().includes(domain),
      )
    for (const env of [listed, demo]) {
      for (const path of ['/', '/invoices/INV-1', '/settings/company', '/settings/deliveries']) {
        const html = await (await app.request(path, {}, env)).text()
        expect(html).toContain(' data-demo-mail-restricted')
        expect(named(html)).toEqual([])
      }
    }
    const production = await (
      await app.request('/invoices/INV-1', {}, { ...listed, ENVIRONMENT: 'prod' })
    ).text()
    expect(production).not.toContain('data-demo-mail-restricted')
    expect(named(production)).toEqual([])
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
