/** Review links track an authenticated opening; they never authorize a run. */
export interface ScheduledReviewContext {
  runId: number
  userId: number
  expiresAt: string
}
const encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
const decode = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
    character.charCodeAt(0),
  )
const signingKey = (key: Uint8Array) => {
  if (key.length < 32)
    throw new TypeError('The review-link signing key must contain at least 32 bytes.')
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(key).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}
const message = (context: ScheduledReviewContext, nonce: string) =>
  new TextEncoder().encode(
    `scheduled-run-review:v1:${context.runId}:${context.userId}:${context.expiresAt}:${nonce}`,
  )
export const scheduledReviewTokenHash = async (token: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
export const issueScheduledReviewToken = async (
  context: ScheduledReviewContext,
  key: Uint8Array,
) => {
  const nonce = encode(crypto.getRandomValues(new Uint8Array(32)))
  const signature = encode(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', await signingKey(key), message(context, nonce)),
    ),
  )
  const token = `${nonce}.${signature}`
  return { token, hash: await scheduledReviewTokenHash(token) }
}
export const verifyScheduledReviewToken = async (
  token: string,
  context: ScheduledReviewContext,
  key: Uint8Array,
): Promise<boolean> => {
  if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(token)) return false
  const [nonce, signature] = token.split('.') as [string, string]
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await signingKey(key),
      new Uint8Array(decode(signature)).buffer,
      message(context, nonce),
    )
  } catch {
    return false
  }
}
