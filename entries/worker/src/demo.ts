import {
  billDemoBacklog,
  createD1DemoResetDriver,
  wipeAndSeedDemo,
} from '@ezacto/db/d1'
import { demoDeployment, type AppEnv } from './app.js'

/**
 * The nightly rebuild of the public demo, and the ticks that fill it in.
 *
 * ezacto.io publishes its own sign-in credentials, so anyone can do anything to
 * it. That is only tolerable because none of it survives the night.
 *
 * The work does not fit in one invocation. Three years of eight clients is a
 * few hundred generate/send/pay chains, so the daily cron does the destructive
 * half -- empty, seed, done -- and the every-minute cron bills a slice at a
 * time until the backlog is empty. A tick that dies costs its own slice and
 * nothing else, because the backlog is read from the uninvoiced rows rather
 * than remembered.
 */

/** Enough to finish a three-year demo inside half an hour of quiet ticks. */
const INVOICES_PER_TICK = 10

export const DEMO_REBUILD_CRON = '0 3 * * *'

export interface DemoMaintenanceOutcome {
  readonly ran: 'nothing' | 'rebuild' | 'billing'
  readonly billed?: number
  readonly remaining?: number
}

/**
 * Runs nothing at all unless this deployment is the demo. The check is here
 * rather than at the call site because the consequence of getting it wrong is
 * an emptied production database, and a guard you have to remember is a guard
 * you will one day forget.
 */
export const runDemoMaintenance = async (
  /** Narrower than `WorkerEnv` on purpose: the gate and the database, nothing else. */
  env: AppEnv & { DB: D1Database },
  cron: string,
  now: () => string = () => new Date().toISOString(),
): Promise<DemoMaintenanceOutcome> => {
  if (!demoDeployment(env)) return { ran: 'nothing' }
  const driver = createD1DemoResetDriver(env.DB)
  const at = now()

  if (cron === DEMO_REBUILD_CRON) {
    await wipeAndSeedDemo(driver, { now: at, confirm: 'wipe-and-reload' })
    return { ran: 'rebuild' }
  }

  const billing = await billDemoBacklog(driver, {
    now: at,
    confirm: 'wipe-and-reload',
    limit: INVOICES_PER_TICK,
  })
  return { ran: 'billing', billed: billing.billed, remaining: billing.remaining }
}
