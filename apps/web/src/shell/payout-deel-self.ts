import { EzactoApiError } from '@conflict-hq/ezacto-client'

/**
 * "Where you are paid", Deel part (issue 1152). A person enters the email they use
 * in Deel; that is what Deel pays and what the sync matches on. Shown only when
 * an administrator has turned Deel on.
 */
type ProviderName = 'deel' | 'wise'

export interface DeelSelfPayoutApi {
  listPayoutProviders?(args?: { signal?: AbortSignal }): Promise<{
    data: readonly { provider: ProviderName; enabled: boolean }[]
  }>
  listPayoutAccounts?(args: { id: number; signal?: AbortSignal }): Promise<{
    data: readonly { id: number; provider: string; external_id: string }[]
  }>
  linkPayoutAccount?(args: {
    id: number
    body: { provider: ProviderName; external_id: string }
    signal?: AbortSignal
  }): Promise<unknown>
  detachPayoutAccount?(args: { id: number; signal?: AbortSignal }): Promise<void>
}

const failure = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    const body = error.body as { error?: { message?: string; fields?: { message?: string }[] } } | null
    return body?.error?.fields?.[0]?.message ?? body?.error?.message ?? 'That could not be saved. Try again.'
  }
  return 'That could not be saved. Try again.'
}

export const wireDeelSelfPayout = (root: HTMLElement, api: DeelSelfPayoutApi, userId: number): void => {
  const summary = root.querySelector<HTMLElement>('[data-settings-payout-deel-summary]')
  const remove = root.querySelector<HTMLButtonElement>('[data-settings-payout-deel-remove]')
  const form = root.querySelector<HTMLFormElement>('[data-settings-payout-deel-form]')
  const result = root.querySelector<HTMLElement>('[data-settings-payout-deel-result]')
  if (!summary || !remove || !form || !result) return

  let accountId: number | null = null

  const load = async (): Promise<void> => {
    if (api.listPayoutProviders === undefined || api.listPayoutAccounts === undefined) {
      root.hidden = true
      return
    }
    try {
      const [providers, accounts] = await Promise.all([
        api.listPayoutProviders(),
        api.listPayoutAccounts({ id: userId }),
      ])
      const deelOn = providers.data.find((row) => row.provider === 'deel')?.enabled === true
      root.hidden = !deelOn
      if (!deelOn) return
      const deel = accounts.data.find((account) => account.provider === 'deel') ?? null
      accountId = deel?.id ?? null
      if (deel === null) {
        summary.textContent = 'No Deel destination yet. Enter the email you use in Deel.'
        remove.hidden = true
        form.hidden = false
      } else {
        summary.textContent = `Deel destination: ${deel.external_id}. Deel pays this address.`
        remove.hidden = false
        form.hidden = true
      }
    } catch (error) {
      root.hidden = true
      result.textContent = failure(error)
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (api.linkPayoutAccount === undefined) return
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim()
    if (email === '') return
    result.textContent = 'Saving…'
    try {
      await api.linkPayoutAccount({ id: userId, body: { provider: 'deel', external_id: email } })
      form.reset()
      result.textContent = 'Deel destination saved.'
      await load()
    } catch (error) {
      result.textContent = failure(error)
    }
  })

  remove.addEventListener('click', async () => {
    if (accountId === null || api.detachPayoutAccount === undefined) return
    remove.disabled = true
    try {
      await api.detachPayoutAccount({ id: accountId })
      result.textContent = 'Deel destination removed.'
      await load()
    } catch (error) {
      result.textContent = failure(error)
    } finally {
      remove.disabled = false
    }
  })

  void load()
}
