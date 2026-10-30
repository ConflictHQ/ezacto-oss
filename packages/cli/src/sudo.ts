import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { EzactoClient, type InvoiceElevationIssued } from '@conflict-hq/ezacto-client'
import { confidentialityFilteredFetch } from './money.js'
import type { OrganizationConfig } from './config.js'
export interface SudoRuntime {
  stderr(line: string): void
  readStdin(): Promise<string>
  readSecret?(prompt: string): Promise<string>
}
/** Readline owns raw mode and restores it on close; the sink never echoes credentials. */
export const readTerminalSecret = async (prompt: string): Promise<string> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error(
      'Interactive reauthentication needs a terminal. Use --reauth-stdin with JSON from a private pipe.',
    )
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const reader = createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
    historySize: 0,
  })
  process.stderr.write(prompt)
  try {
    return await reader.question('')
  } finally {
    reader.close()
    sink.end()
    process.stderr.write('\n')
  }
}
const safeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: 'error' })
export const createSudoClients = (organization: OrganizationConfig) => ({
  issuer: new EzactoClient({
    baseUrl: organization.base_url,
    token: organization.token,
    fetch: safeFetch,
  }),
  business: new EzactoClient({
    baseUrl: organization.base_url,
    token: organization.token,
    fetch: confidentialityFilteredFetch(safeFetch),
  }),
})
interface Reauthentication {
  email: string
  password: string
  code?: string
  method?: 'totp' | 'email'
}
const reauthentication = async (
  runtime: SudoRuntime,
  fromStdin: boolean,
): Promise<Reauthentication> => {
  if (!fromStdin) {
    const ask = runtime.readSecret
    if (!ask) throw new Error('Interactive reauthentication needs a terminal. Use --reauth-stdin.')
    return { email: (await ask('Verified email: ')).trim(), password: await ask('Password: ') }
  }
  let value: unknown
  try {
    value = JSON.parse(await runtime.readStdin())
  } catch {
    throw new Error(
      '--reauth-stdin expects one JSON object with email, password and optional authenticator/recovery code.',
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid reauthentication input.')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !['email', 'password', 'code', 'method'].includes(key)) ||
    typeof input.email !== 'string' ||
    typeof input.password !== 'string' ||
    input.email.trim() === '' ||
    input.password === '' ||
    (input.code !== undefined && typeof input.code !== 'string') ||
    (input.method !== undefined && input.method !== 'totp' && input.method !== 'email')
  )
    throw new Error('Invalid reauthentication input; use email, password and optional code/method.')
  return {
    email: input.email.trim(),
    password: input.password,
    ...(input.code === undefined ? {} : { code: input.code as string }),
    ...(input.method === undefined ? {} : { method: input.method as 'totp' | 'email' }),
  }
}
export const beginInvoiceSudo = async (
  client: EzactoClient,
  invoiceId: number,
  runtime: SudoRuntime,
  fromStdin: boolean,
): Promise<InvoiceElevationIssued> => {
  const identity = (await client.getWhoami()).data
  if (identity.profile !== 'administrator' || identity.authentication.kind !== 'token')
    throw new Error('ez sudo requires an administrator API token.')
  const credentials = await reauthentication(runtime, fromStdin)
  let data = (
    await client.createInvoiceElevation({
      body: { invoice_id: invoiceId, email: credentials.email, password: credentials.password },
      signal: AbortSignal.timeout(30000),
    })
  ).data
  credentials.password = ''
  if (data.status === 'challenge_required') {
    let challenge = data,
      code = credentials.code?.trim(),
      email = credentials.method === 'email' || !challenge.methods.includes('totp')
    if (!email && !code) {
      if (fromStdin || !runtime.readSecret)
        throw new Error(
          'The account requires MFA. Include a current authenticator or recovery code in --reauth-stdin, or run interactively.',
        )
      code = (
        await runtime.readSecret(
          challenge.methods.includes('email')
            ? 'Authenticator/recovery code (or type email): '
            : 'Authenticator or recovery code: ',
        )
      ).trim()
      email = code.toLowerCase() === 'email'
    }
    if (email) {
      if (!challenge.methods.includes('email'))
        throw new Error('Email MFA is not available for this account.')
      if (fromStdin || !runtime.readSecret)
        throw new Error(
          'Email MFA requires an interactive prompt. Run ez sudo without --reauth-stdin.',
        )
      challenge = (
        await client.sendInvoiceElevationEmailCode({
          body: { challenge_token: challenge.challenge_token },
          signal: AbortSignal.timeout(30000),
        })
      ).data
      code = (await runtime.readSecret('Verification code from email: ')).trim()
    }
    if (!code || code.length > 64) throw new Error('A current verification code is required.')
    data = (
      await client.verifyInvoiceElevation({
        body: { challenge_token: challenge.challenge_token, code },
        signal: AbortSignal.timeout(30000),
      })
    ).data
  }
  if (
    data.status !== 'elevated' ||
    data.invoice_id !== invoiceId ||
    data.scope !== 'invoice_drafts:write' ||
    !/^ezi_[0-9a-f]{64}$/.test(data.credential)
  )
    throw new Error('The server did not return an invoice-bound elevation.')
  return data
}
export const endInvoiceSudo = async (
  client: EzactoClient,
  grant: InvoiceElevationIssued,
  runtime: SudoRuntime,
) => {
  try {
    await client.revokeInvoiceElevation({ id: grant.id, signal: AbortSignal.timeout(5000) })
  } catch {
    runtime.stderr(
      `The temporary elevation could not be revoked; it expires at ${grant.expires_at}.`,
    )
  }
}
