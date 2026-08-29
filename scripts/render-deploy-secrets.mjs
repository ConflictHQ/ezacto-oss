import { pathToFileURL } from 'node:url'

const cursorPattern = /^[A-Za-z0-9_-]{43}$/

const canonicalCursor = (value) => {
  if (typeof value !== 'string' || !cursorPattern.test(value)) {
    throw new TypeError(
      'API_CURSOR_SIGNING_KEY must be canonical base64url for exactly 32 bytes',
    )
  }
  const bytes = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  const encoded = bytes
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  if (bytes.byteLength !== 32 || encoded !== value) {
    throw new TypeError(
      'API_CURSOR_SIGNING_KEY must be canonical base64url for exactly 32 bytes',
    )
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
  const clientId = optionalCredential(environment.OIDC_GOOGLE_CLIENT_ID)
  const clientSecret = optionalCredential(environment.OIDC_GOOGLE_CLIENT_SECRET)
  if ((clientId === null) !== (clientSecret === null)) {
    throw new TypeError(
      'OIDC_GOOGLE_CLIENT_ID and OIDC_GOOGLE_CLIENT_SECRET must be configured together',
    )
  }
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
  return {
    API_CURSOR_SIGNING_KEY: cursor,
    OIDC_GOOGLE_CLIENT_ID: clientId,
    OIDC_GOOGLE_CLIENT_SECRET: clientSecret,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_SESSION_TOKEN: sessionToken,
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
