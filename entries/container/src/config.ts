import { isAbsolute, normalize, resolve } from 'node:path'
import type { AppEnv } from '../../worker/src/app.js'

export interface ContainerConfig {
  host: string
  port: number
  dataDirectory: string
  databasePath: string
  attachmentDirectory: string
  /** Uploaded brand marks (#489), kept apart from the attachment content store. */
  brandDirectory: string
  appBaseUrl: string
  cursorSigningKey: Uint8Array
  /**
   * Portal magic-link signing key. Absent means portal auth is off: the routes
   * hand out sessions, so an install with no key must not serve them rather
   * than serve them with a weak one. Same rule as the Worker's.
   */
  magicLinkSigningKey?: Uint8Array
  smtp: { url: string; from: string }
  appEnv: AppEnv
}

const required = (
  environment: NodeJS.ProcessEnv,
  name: string,
  maximum: number,
): string => {
  const value = environment[name]
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!
      return code <= 31 || code === 127
    })
  ) {
    throw new TypeError(`${name} is missing or invalid`)
  }
  return value
}

const optional = (
  environment: NodeJS.ProcessEnv,
  name: string,
  maximum: number,
): string | undefined => {
  if (environment[name] === undefined) return undefined
  return required(environment, name, maximum)
}

const origin = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('APP_BASE_URL must be an absolute application origin')
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && parsed.hostname === 'localhost'))
  ) {
    throw new TypeError(
      'APP_BASE_URL must use HTTPS outside localhost and contain only an origin',
    )
  }
  return parsed.origin
}

const signingKey = (encoded: string): Uint8Array => {
  if (
    encoded.length > 128 ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new TypeError('API_CURSOR_SIGNING_KEY must be canonical base64url')
  }
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== encoded) {
    throw new TypeError('API_CURSOR_SIGNING_KEY must decode to exactly 32 bytes')
  }
  return new Uint8Array(bytes)
}

const port = (value: string | undefined): number => {
  const candidate = value ?? '3000'
  if (!/^[1-9][0-9]{0,4}$/u.test(candidate)) {
    throw new TypeError('PORT must be an integer between 1 and 65535')
  }
  const parsed = Number(candidate)
  if (parsed > 65_535) {
    throw new TypeError('PORT must be an integer between 1 and 65535')
  }
  return parsed
}

const dataDirectory = (value: string | undefined): string => {
  const candidate = value ?? '/data'
  if (
    !isAbsolute(candidate) ||
    normalize(candidate) !== candidate ||
    resolve(candidate) === '/' ||
    candidate.length > 2_048
  ) {
    throw new TypeError(
      'EZACTO_DATA_DIR must be a normalized absolute directory below root',
    )
  }
  return candidate
}

export const readContainerConfig = (
  environment: NodeJS.ProcessEnv,
): ContainerConfig => {
  const directory = dataDirectory(environment.EZACTO_DATA_DIR)
  const appBaseUrl = origin(required(environment, 'APP_BASE_URL', 2_048))
  const googleClientId = optional(environment, 'OIDC_GOOGLE_CLIENT_ID', 512)
  const googleClientSecret = optional(
    environment,
    'OIDC_GOOGLE_CLIENT_SECRET',
    4_096,
  )
  const bootstrapToken = optional(environment, 'EZACTO_BOOTSTRAP_TOKEN', 512)
  const magicLinkKey = optional(environment, 'MAGIC_LINK_SIGNING_KEY', 128)
  const brandName = optional(environment, 'BRAND_NAME', 200)
  const brandTagline = optional(environment, 'BRAND_TAGLINE', 500)
  const brandDescription = optional(environment, 'BRAND_DESCRIPTION', 1_000)
  const brandFavicon = optional(environment, 'BRAND_FAVICON', 2_048)
  const brandWordmarkLight = optional(environment, 'BRAND_WORDMARK_LIGHT', 2_048)
  const brandWordmarkDark = optional(environment, 'BRAND_WORDMARK_DARK', 2_048)
  const brandEmailSenderName = optional(environment, 'BRAND_EMAIL_SENDER_NAME', 200)
  const appEnv: AppEnv = {
    ENVIRONMENT: optional(environment, 'ENVIRONMENT', 64) ?? 'container',
    RELEASE: optional(environment, 'RELEASE', 128) ?? 'container',
    APP_BASE_URL: appBaseUrl,
    ...(googleClientId === undefined
      ? {}
      : { OIDC_GOOGLE_CLIENT_ID: googleClientId }),
    ...(googleClientSecret === undefined
      ? {}
      : { OIDC_GOOGLE_CLIENT_SECRET: googleClientSecret }),
    ...(bootstrapToken === undefined
      ? {}
      : { EZACTO_BOOTSTRAP_TOKEN: bootstrapToken }),
    ...(brandName === undefined ? {} : { BRAND_NAME: brandName }),
    ...(brandTagline === undefined ? {} : { BRAND_TAGLINE: brandTagline }),
    ...(brandDescription === undefined ? {} : { BRAND_DESCRIPTION: brandDescription }),
    ...(brandFavicon === undefined ? {} : { BRAND_FAVICON: brandFavicon }),
    ...(brandWordmarkLight === undefined ? {} : { BRAND_WORDMARK_LIGHT: brandWordmarkLight }),
    ...(brandWordmarkDark === undefined ? {} : { BRAND_WORDMARK_DARK: brandWordmarkDark }),
    ...(brandEmailSenderName === undefined ? {} : { BRAND_EMAIL_SENDER_NAME: brandEmailSenderName }),
  }
  return {
    host: optional(environment, 'HOST', 255) ?? '0.0.0.0',
    port: port(environment.PORT),
    dataDirectory: directory,
    databasePath: `${directory}/db.sqlite`,
    attachmentDirectory: `${directory}/attachments`,
    brandDirectory: `${directory}/brand`,
    appBaseUrl,
    cursorSigningKey: signingKey(
      required(environment, 'API_CURSOR_SIGNING_KEY', 128),
    ),
    ...(magicLinkKey === undefined
      ? {}
      : { magicLinkSigningKey: signingKey(magicLinkKey) }),
    smtp: {
      url: required(environment, 'SMTP_URL', 8_192),
      from: required(environment, 'SMTP_FROM', 320),
    },
    appEnv,
  }
}
