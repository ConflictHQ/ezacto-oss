import { pathToFileURL } from 'node:url'

const cursorPattern = /^[A-Za-z0-9_-]{43}$/

/**
 * The portal's magic-link signing key, which is optional and validated exactly
 * like the cursor key because the worker parses it with the same function.
 *
 * Absent means the portal routes are not served at all -- deliberately, so that
 * "configured badly" and "not configured" cannot look alike on routes that hand
 * out sessions. Absent must therefore still reach Wrangler as an explicit null,
 * or a key removed from the environment would linger on the deployment.
 */
const optionalSigningKey = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') return null
  return canonicalSigningKey(value.trim(), field)
}

const canonicalCursor = (value) => canonicalSigningKey(value, 'API_CURSOR_SIGNING_KEY')

const canonicalSigningKey = (value, field) => {
  if (typeof value !== 'string' || !cursorPattern.test(value)) {
    throw new TypeError(`${field} must be canonical base64url for exactly 32 bytes`)
  }
  const bytes = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  const encoded = bytes
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  if (bytes.byteLength !== 32 || encoded !== value) {
    throw new TypeError(`${field} must be canonical base64url for exactly 32 bytes`)
  }
  return value
}

const optionalCredential = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

const optionalSesCredential = (value, field, maximum) => {
  if (typeof value !== 'string' || value === '') return null
  if (
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`)
  }
  return value
}

const optionalSesConfig = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

export const deploySecretPayload = (environment) => {
  const cursor = canonicalCursor(environment.API_CURSOR_SIGNING_KEY)
  const magicLink = optionalSigningKey(
    environment.MAGIC_LINK_SIGNING_KEY,
    'MAGIC_LINK_SIGNING_KEY',
  )
  const clientId = optionalCredential(environment.OIDC_GOOGLE_CLIENT_ID)
  const clientSecret = optionalCredential(environment.OIDC_GOOGLE_CLIENT_SECRET)
  if ((clientId === null) !== (clientSecret === null)) {
    throw new TypeError(
      'OIDC_GOOGLE_CLIENT_ID and OIDC_GOOGLE_CLIENT_SECRET must be configured together',
    )
  }
  // Native Sign in with Apple. A single value -- the expected audience of the
  // identity token the app posts (its bundle id, optionally a web Services ID
  // beside it). No secret pair: the token is signed by Apple, not by us.
  // Rendered explicitly so removing it clears the Worker on the next deploy.
  const appleClientId = optionalCredential(environment.APPLE_CLIENT_ID)
  const accessKeyId = optionalSesCredential(
    environment.AWS_ACCESS_KEY_ID,
    'AWS_ACCESS_KEY_ID',
    256,
  )
  const secretAccessKey = optionalSesCredential(
    environment.AWS_SECRET_ACCESS_KEY,
    'AWS_SECRET_ACCESS_KEY',
    512,
  )
  const sessionToken = optionalSesCredential(
    environment.AWS_SESSION_TOKEN,
    'AWS_SESSION_TOKEN',
    8192,
  )
  const region = optionalSesConfig(environment.SES_REGION)
  const from = optionalSesConfig(environment.SES_FROM)
  const configurationSet = optionalSesConfig(environment.SES_CONFIGURATION_SET)
  const sesConfigured = [
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
    from,
    configurationSet,
  ].some((value) => value !== null)
  if (
    sesConfigured &&
    (accessKeyId === null ||
      secretAccessKey === null ||
      region === null ||
      from === null)
  ) {
    throw new TypeError(
      'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_REGION, and SES_FROM must be configured together',
    )
  }
  const mailgunApiKey = optionalSesCredential(
    environment.MAILGUN_API_KEY,
    'MAILGUN_API_KEY',
    512,
  )
  // One transport per deployment. Two configured providers cannot share a
  // sender, and picking one silently would decide where invoices come from.
  if (mailgunApiKey !== null && sesConfigured) {
    throw new TypeError(
      'Configure either Mailgun or SES, not both',
    )
  }
  /**
   * The payment integrations. None of these reached a deployment before, which
   * is why the QuickBooks connect screen reported "not configured" on every
   * environment however the Intuit app was set up -- the routes were mounted
   * and the credential never arrived.
   *
   * All optional and all explicitly null when absent, for the same reason the
   * magic-link key is: a secret removed from the environment must reach
   * Wrangler as a null, or it lingers on the deployment after somebody thought
   * they had taken it away.
   */
  const quickBooksClientId = optionalCredential(environment.QUICKBOOKS_CLIENT_ID)
  const quickBooksClientSecret = optionalCredential(environment.QUICKBOOKS_CLIENT_SECRET)
  if ((quickBooksClientId === null) !== (quickBooksClientSecret === null)) {
    throw new TypeError(
      'QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be configured together',
    )
  }
  const billDevKey = optionalCredential(environment.BILL_DEV_KEY)
  const billCompanyId = optionalCredential(environment.BILL_COMPANY_ID)
  const billUsername = optionalCredential(environment.BILL_USERNAME)
  const billPassword = optionalCredential(environment.BILL_PASSWORD)
  const billParts = [billDevKey, billCompanyId, billUsername, billPassword]
  // All four or none: BILL's sign-in takes every one of them, so three is a
  // configuration that cannot sign in and an operator who believes it can.
  if (billParts.some((part) => part !== null) && billParts.some((part) => part === null)) {
    throw new TypeError(
      'BILL_DEV_KEY, BILL_COMPANY_ID, BILL_USERNAME and BILL_PASSWORD must be configured together',
    )
  }

  return {
    API_CURSOR_SIGNING_KEY: cursor,
    MAGIC_LINK_SIGNING_KEY: magicLink,
    OIDC_GOOGLE_CLIENT_ID: clientId,
    OIDC_GOOGLE_CLIENT_SECRET: clientSecret,
    APPLE_CLIENT_ID: appleClientId,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_SESSION_TOKEN: sessionToken,
    MAILGUN_API_KEY: mailgunApiKey,
    QUICKBOOKS_CLIENT_ID: quickBooksClientId,
    QUICKBOOKS_CLIENT_SECRET: quickBooksClientSecret,
    QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN: optionalCredential(
      environment.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN,
    ),
    // `runtime.ts` reads this and nothing ever delivered it, so a deployment
    // could only ever reach live Intuit however it was configured -- the same
    // shape of defect as the credentials themselves once had, where the routes
    // mounted and the value never arrived. Absent still means live, which is
    // the safe way round; the point is that `sandbox` is now reachable at all.
    QUICKBOOKS_ENVIRONMENT: optionalCredential(environment.QUICKBOOKS_ENVIRONMENT),
    // The organisation's own Wise API token. Not an OAuth pair: it
    // authenticates as the business that actually sends the money, and a
    // contractor supplies a destination rather than a grant.
    WISE_TOKEN: optionalCredential(environment.WISE_TOKEN),
    // Which profile pays, where the token reaches more than one.
    WISE_PROFILE_ID: optionalCredential(environment.WISE_PROFILE_ID),
    // The PEM Wise signs deliveries with. Without it the webhook route is not
    // mounted at all, so losing it on the way through the deploy leaves a
    // connection that can send money and cannot be told what became of it.
    WISE_WEBHOOK_PUBLIC_KEY: optionalCredential(environment.WISE_WEBHOOK_PUBLIC_KEY),
    BILL_DEV_KEY: billDevKey,
    BILL_COMPANY_ID: billCompanyId,
    BILL_USERNAME: billUsername,
    BILL_PASSWORD: billPassword,
    BILL_REPLY_TO_USER_ID: optionalCredential(environment.BILL_REPLY_TO_USER_ID),
    STRIPE_API_KEY: optionalCredential(environment.STRIPE_API_KEY),
    STRIPE_WEBHOOK_SECRET: optionalCredential(environment.STRIPE_WEBHOOK_SECRET),
    // Rendered because `secret bulk` replaces the Worker's whole secret set, so
    // anything this payload omits is deleted on the next deploy. The bootstrap
    // workflows put this key on the Worker themselves, and every deploy since
    // has removed it again -- leaving the documented way to give an instance its
    // first credential working only until the next deploy.
    EZACTO_BOOTSTRAP_TOKEN: optionalCredential(environment.EZACTO_BOOTSTRAP_TOKEN),
    // Error reporting. Absent means Sentry is off; still rendered explicitly so
    // `secret bulk` does not drop it and a removed DSN actually clears.
    SENTRY_DSN: optionalCredential(environment.SENTRY_DSN),
  }
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  try {
    process.stdout.write(`${JSON.stringify(deploySecretPayload(process.env))}\n`)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'deploy secret payload is invalid'}\n`,
    )
    process.exitCode = 1
  }
}
