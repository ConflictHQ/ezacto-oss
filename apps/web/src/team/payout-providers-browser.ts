import { EzactoApiError } from '@conflict-hq/ezacto-client'

/**
 * The Deel destination and the provider switches on a person's payout panel
 * (issue 1152). A person may hold a destination at every provider an administrator
 * has enabled; Wise keeps its own flow in the team browser.
 */
type ProviderName = 'deel' | 'wise'

export type PreferenceSource = 'person' | 'administrator' | 'automatic'

export interface PayoutPreferenceDto {
  user_id: number
  provider: ProviderName | null
  effective_provider: ProviderName
  organization_default: ProviderName
  version: number
  set_by: PreferenceSource | null
  linked_providers: readonly ProviderName[]
}

export interface PayoutPreferenceRosterDto {
  organization_default: ProviderName
  people: readonly {
    user_id: number
    name: string
    provider: ProviderName | null
    version: number
    set_by: PreferenceSource | null
    linked_providers: readonly ProviderName[]
  }[]
}

export interface PayoutProvidersApi {
  /** A person's default provider (issue 1152): their own, or an administrator's. */
  getPayoutPreference?(args: { id: number; signal?: AbortSignal }): Promise<{ data: PayoutPreferenceDto }>
  setPayoutPreference?(args: {
    id: number
    provider: ProviderName | null
    expectedVersion: number
    signal?: AbortSignal
  }): Promise<void>
  listPayoutPreferences?(args?: { signal?: AbortSignal }): Promise<{ data: PayoutPreferenceRosterDto }>
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
  setPayoutProviderEnabled?(args: {
    provider: ProviderName
    body: { enabled: boolean }
    signal?: AbortSignal
  }): Promise<void>
}

const failure = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    const body = error.body as { error?: { message?: string; fields?: { message?: string }[] } } | null
    return body?.error?.fields?.[0]?.message ?? body?.error?.message ?? 'That could not be saved. Try again.'
  }
  return 'That could not be saved. Try again.'
}

export const createPayoutProvidersPanel = (root: HTMLElement, api: PayoutProvidersApi) => {
  const deelSection = root.querySelector<HTMLElement>('[data-team-payout-deel]')
  const deelSummary = root.querySelector<HTMLElement>('[data-team-payout-deel-summary]')
  const deelRemove = root.querySelector<HTMLButtonElement>('[data-team-payout-deel-remove]')
  const deelForm = root.querySelector<HTMLFormElement>('[data-team-payout-deel-form]')
  const deelResult = root.querySelector<HTMLElement>('[data-team-payout-deel-result]')
  const switches = root.querySelector<HTMLElement>('[data-team-payout-providers]')
  const switchResult = root.querySelector<HTMLElement>('[data-team-provider-result]')
  if (!deelSection || !deelSummary || !deelRemove || !deelForm || !deelResult || !switches || !switchResult) {
    // Without the panel, Wise stays as it was: the server still refuses a disabled provider.
    return { load: async () => ({ wise: true }) }
  }

  let userId: number | null = null
  let signal: AbortSignal | null = null
  let enabled: Record<ProviderName, boolean> = { deel: false, wise: false }
  let deelAccountId: number | null = null

  const toggles = () =>
    [...switches.querySelectorAll<HTMLInputElement>('[data-team-provider-toggle]')]

  const paint = (accounts: readonly { id: number; provider: string; external_id: string }[]) => {
    const deel = accounts.find((account) => account.provider === 'deel') ?? null
    deelAccountId = deel?.id ?? null
    deelSection.hidden = !enabled.deel
    if (!enabled.deel) return
    if (deel === null) {
      deelSummary.textContent = 'No Deel destination yet. Enter the email they use in Deel.'
      deelRemove.hidden = true
      deelForm.hidden = false
    } else {
      deelSummary.textContent = `Deel destination: ${deel.external_id}. Deel pays this address.`
      deelRemove.hidden = false
      deelForm.hidden = true
    }
    for (const toggle of toggles()) toggle.checked = enabled[toggle.dataset['teamProviderToggle'] as ProviderName]
  }

  const load = async (
    person: number,
    active: AbortSignal,
    canAdminister: boolean,
  ): Promise<{ wise: boolean }> => {
    userId = person
    signal = active
    switches.hidden = !canAdminister || api.setPayoutProviderEnabled === undefined
    if (api.listPayoutProviders === undefined || api.listPayoutAccounts === undefined) {
      deelSection.hidden = true
      return { wise: true }
    }
    try {
      const [providers, accounts] = await Promise.all([
        api.listPayoutProviders({ signal: active }),
        api.listPayoutAccounts({ id: person, signal: active }),
      ])
      enabled = {
        deel: providers.data.find((row) => row.provider === 'deel')?.enabled === true,
        wise: providers.data.find((row) => row.provider === 'wise')?.enabled === true,
      }
      paint(accounts.data)
      return { wise: enabled.wise }
    } catch (error) {
      deelSection.hidden = true
      deelResult.textContent = failure(error)
      return { wise: true }
    }
  }

  deelForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (userId === null || signal === null || api.linkPayoutAccount === undefined) return
    const email = (deelForm.elements.namedItem('email') as HTMLInputElement).value.trim()
    if (email === '') return
    deelResult.textContent = 'Saving…'
    try {
      await api.linkPayoutAccount({
        id: userId,
        body: { provider: 'deel', external_id: email },
        signal,
      })
      deelForm.reset()
      deelResult.textContent = 'Deel destination saved.'
      await load(userId, signal, switches.hidden === false)
    } catch (error) {
      deelResult.textContent = failure(error)
    }
  })

  deelRemove.addEventListener('click', async () => {
    if (userId === null || signal === null || deelAccountId === null || api.detachPayoutAccount === undefined) return
    deelRemove.disabled = true
    try {
      await api.detachPayoutAccount({ id: deelAccountId, signal })
      deelResult.textContent = 'Deel destination removed.'
      await load(userId, signal, switches.hidden === false)
    } catch (error) {
      deelResult.textContent = failure(error)
    } finally {
      deelRemove.disabled = false
    }
  })

  for (const toggle of toggles()) {
    toggle.addEventListener('change', async () => {
      const provider = toggle.dataset['teamProviderToggle'] as ProviderName
      if (signal === null || api.setPayoutProviderEnabled === undefined) return
      try {
        await api.setPayoutProviderEnabled({ provider, body: { enabled: toggle.checked }, signal })
        enabled = { ...enabled, [provider]: toggle.checked }
        switchResult.textContent = `${provider === 'deel' ? 'Deel' : 'Wise'} ${toggle.checked ? 'enabled' : 'disabled'} for payouts.`
        if (userId !== null) await load(userId, signal, true)
      } catch (error) {
        toggle.checked = !toggle.checked
        switchResult.textContent = failure(error)
      }
    })
  }

  return { load }
}
