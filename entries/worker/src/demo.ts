import {
  billDemoBacklog,
  createD1DemoResetDriver,
  DEMO_ORGANIZATION_NAME,
  wipeAndSeedDemo,
} from '@ezacto/db/d1'
import { configuredEmailSender } from '@ezacto/mailer'
import { demoDeployment, type AppEnv, type RuntimeServices, type WorkerEnv } from './app.js'
import { resolveMailFrom } from './runtime.js'

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

/**
 * The demo's sender: the deployment's own configured address, as the default
 * every invoice email leaves from (#931).
 *
 * Sender identities are read-only on the demo and the nightly rebuild empties
 * them with everything else, so without this no visitor could send an invoice
 * at all -- and sending one, recorded and suppressed, is much of what the demo
 * is for. Nothing about it is invented: the address is the one the deployment
 * is configured to send from, attested by the same verifier a Verify click
 * runs, and none of it can be changed from the demo afterwards.
 *
 * Only where that verifier is Mailgun's, which reads the deployment's own
 * configuration and calls nobody. Verifying an SES identity is a call to AWS,
 * and the demo makes none, so an SES demo goes without a sender and says so
 * when a visitor tries to send.
 */
export const seedDemoSender = async (
  services: Pick<RuntimeServices, 'emailConfiguration' | 'senderIdentityVerifier'>,
  env: WorkerEnv,
  now: () => string = () => new Date().toISOString(),
): Promise<'seeded' | 'unavailable'> => {
  const verifier = services.senderIdentityVerifier
  const from = resolveMailFrom(env)
  if (!demoDeployment(env) || verifier?.provider !== 'mailgun' || from === undefined) {
    return 'unavailable'
  }
  const at = now()
  const address = configuredEmailSender(from).email
  const configuration = services.emailConfiguration
  // The rebuilt demo's owner. Bootstrap always takes user 1, and the rebuild
  // bootstraps before anything else.
  const owner = 1
  const created = await configuration.createSenderIdentity({
    id: 1,
    email: address,
    displayName: env.BRAND_EMAIL_SENDER_NAME?.trim() || DEMO_ORGANIZATION_NAME,
    provider: verifier.provider,
    providerIdentity: address,
    actorUserId: owner,
    commandId: 'demo.sender.create',
    occurredAt: at,
  })
  const attested = await configuration.recordSenderEvidence({
    id: created.id,
    expectedEvidenceVersion: 0,
    evidence: await verifier.verify(created, AbortSignal.timeout(10_000)),
    actorUserId: owner,
    commandId: 'demo.sender.evidence',
    occurredAt: at,
  })
  await configuration.setDefaultSenderIdentity({
    id: attested.id,
    expectedVersion: attested.version,
    actorUserId: owner,
    commandId: 'demo.sender.default',
    occurredAt: at,
  })
  return 'seeded'
}
