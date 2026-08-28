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

export const deploySecretPayload = (environment) => {
  const cursor = canonicalCursor(environment.API_CURSOR_SIGNING_KEY)
  const clientId = optionalCredential(environment.OIDC_GOOGLE_CLIENT_ID)
  const clientSecret = optionalCredential(environment.OIDC_GOOGLE_CLIENT_SECRET)
  if ((clientId === null) !== (clientSecret === null)) {
    throw new TypeError(
      'OIDC_GOOGLE_CLIENT_ID and OIDC_GOOGLE_CLIENT_SECRET must be configured together',
    )
  }
  return {
    API_CURSOR_SIGNING_KEY: cursor,
    OIDC_GOOGLE_CLIENT_ID: clientId,
    OIDC_GOOGLE_CLIENT_SECRET: clientSecret,
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
