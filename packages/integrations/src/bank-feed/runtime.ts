import type { BankDepositObservation, BankFeed, NeutralDeposit } from '@ezacto/core'
import { createMercuryBankFeed } from './mercury.js'
import { createWiseBankFeed } from './wise.js'
import { BankFeedError } from './shared.js'
export interface BankFeedEnvironment {
  MERCURY_BANK_FEED_TOKEN?: string
  MERCURY_BANK_FEED_ACCOUNT_ID?: string
  MERCURY_BANK_FEED_CURRENCY?: string
  WISE_BANK_FEED_TOKEN?: string
  WISE_BANK_FEED_PROFILE_ID?: string
  WISE_BANK_FEED_BALANCE_ID?: string
  WISE_BANK_FEED_CURRENCY?: string
  BANK_FEED_ENVIRONMENT?: string
}
export type BankFeedConfiguration =
  | {
      provider: 'mercury'
      token: string
      accountId: string
      currency: string
      environment: 'production' | 'sandbox'
    }
  | {
      provider: 'wise'
      token: string
      profileId: string
      balanceId: string
      currency: string
      environment: 'production' | 'sandbox'
    }
export const bankFeedConfiguration = (
  environment: BankFeedEnvironment,
): BankFeedConfiguration[] => {
  const output: BankFeedConfiguration[] = []
  const mode = environment.BANK_FEED_ENVIRONMENT ?? 'production'
  if (!['production', 'sandbox'].includes(mode)) throw new BankFeedError('configuration')
  const fields = (names: readonly (keyof BankFeedEnvironment)[]) => {
    const values = names.map((name) => environment[name])
    if (values.every((v) => v === undefined || v === '')) return null
    if (values.some((v) => !v || v.trim() !== v || v.length > 1000))
      throw new BankFeedError('configuration')
    return values as string[]
  }
  const mercury = fields([
    'MERCURY_BANK_FEED_TOKEN',
    'MERCURY_BANK_FEED_ACCOUNT_ID',
    'MERCURY_BANK_FEED_CURRENCY',
  ])
  if (mercury)
    output.push({
      provider: 'mercury',
      token: mercury[0]!,
      accountId: mercury[1]!,
      currency: mercury[2]!,
      environment: mode as 'production' | 'sandbox',
    })
  const wise = fields([
    'WISE_BANK_FEED_TOKEN',
    'WISE_BANK_FEED_PROFILE_ID',
    'WISE_BANK_FEED_BALANCE_ID',
    'WISE_BANK_FEED_CURRENCY',
  ])
  if (wise)
    output.push({
      provider: 'wise',
      token: wise[0]!,
      profileId: wise[1]!,
      balanceId: wise[2]!,
      currency: wise[3]!,
      environment: mode as 'production' | 'sandbox',
    })
  return output
}
export interface BankFeedStatus {
  provider: 'mercury' | 'wise'
  configured: boolean
  account_name: string | null
  last_synced_at: string | null
  last_error: string | null
  next_poll_at: string | null
}
export interface BankFeedRuntimeStore {
  ensureAccount(input: {
    provider: 'mercury' | 'wise'
    externalAccountId: string
    name: string
  }): Promise<{ id: number }>
  findAccount(
    provider: string,
    key: string,
  ): Promise<{
    id: number
    name: string
    last_synced_at: string | null
    last_error: string | null
    next_poll_at: string | null
  } | null>
  claim(
    accountId: number,
    holder: string,
    at: string,
  ): Promise<{ cursor: string | null; version: number; scan_from: string; scan_to: string } | null>
  ingest(input: {
    command_id: string
    account_id: number
    deposits: NeutralDeposit[]
    observations?: Record<string, BankDepositObservation>
    page: { expected_version: number; cursor: string | null; holder: string }
  }): Promise<unknown>
  release(accountId: number, holder: string, error: string | null, at: string): Promise<void>
}
const identity = (config: BankFeedConfiguration) =>
  [
    config.environment,
    config.currency,
    config.provider === 'mercury' ? config.accountId : config.profileId + ':' + config.balanceId,
  ].join(':')
/** Polling is read-only at the provider. Only a human confirmation can create a receipt. */
export const createBankFeedRuntime = (options: {
  configurations: BankFeedConfiguration[]
  store: BankFeedRuntimeStore
  now?: () => Date
  fetchImplementation?: typeof fetch
}) => {
  const now = () => (options.now?.() ?? new Date()).toISOString()
  return {
    async status(): Promise<BankFeedStatus[]> {
      const result: BankFeedStatus[] = []
      for (const provider of ['mercury', 'wise'] as const) {
        const config = options.configurations.find((c) => c.provider === provider)
        const account = config ? await options.store.findAccount(provider, identity(config)) : null
        result.push({
          provider,
          configured: !!config,
          account_name: account?.name ?? null,
          last_synced_at: account?.last_synced_at ?? null,
          last_error: account?.last_error ?? null,
          next_poll_at: account?.next_poll_at ?? null,
        })
      }
      return result
    },
    async processDue() {
      let checked = 0,
        failed = 0
      for (const config of options.configurations.slice(0, 2)) {
        const account = await options.store.ensureAccount({
          provider: config.provider,
          externalAccountId: identity(config),
          name:
            config.provider === 'mercury'
              ? 'Mercury ' + config.currency
              : 'Wise ' + config.currency,
        })
        const holder = crypto.randomUUID(),
          claim = await options.store.claim(account.id, holder, now())
        if (!claim) continue
        let error: string | null = null
        try {
          const base = {
            ...config,
            intervalStart: claim.scan_from,
            intervalEnd: claim.scan_to,
            ...(options.fetchImplementation
              ? { fetchImplementation: options.fetchImplementation }
              : {}),
          }
          const feed: BankFeed =
            config.provider === 'mercury'
              ? createMercuryBankFeed({ ...base, ...config })
              : createWiseBankFeed({ ...base, ...config })
          const page = await feed.poll(claim.cursor)
          await options.store.ingest({
            command_id: `feed-${account.id}-${claim.version}`,
            account_id: account.id,
            deposits: page.deposits,
            ...(page.observations ? { observations: page.observations } : {}),
            page: { expected_version: claim.version, cursor: page.cursor, holder },
          })
          checked++
        } catch (cause) {
          failed++
          error =
            cause instanceof BankFeedError
              ? cause.status === 401 || cause.status === 403
                ? 'permission_denied'
                : cause.status === 429
                  ? 'rate_limited'
                  : cause.code === 'configuration'
                    ? 'configuration_invalid'
                    : cause.code === 'response'
                      ? 'invalid_response'
                      : 'provider_unavailable'
              : 'storage_unavailable'
        } finally {
          await options.store.release(account.id, holder, error, now())
        }
      }
      return { checked, failed }
    },
  }
}
/** Partial/malformed bank setup must not break unrelated invoice or payment routes. */
export const createConfiguredBankFeedRuntime = (
  options: Omit<Parameters<typeof createBankFeedRuntime>[0], 'configurations'> & {
    environment: BankFeedEnvironment
  },
) => {
  let configurations: BankFeedConfiguration[] = []
  let invalid = false
  try {
    configurations = bankFeedConfiguration(options.environment)
  } catch {
    invalid = true
  }
  const service = createBankFeedRuntime({ ...options, configurations })
  return {
    ...service,
    status: async () =>
      (await service.status()).map((row) =>
        invalid ? { ...row, last_error: 'configuration_invalid' } : row,
      ),
  }
}
