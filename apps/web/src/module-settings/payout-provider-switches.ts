import { EzactoApiError } from '@conflict-hq/ezacto-client'

/**
 * The payout provider switches on Company > Payouts (#1152). Turning a provider
 * off stops new links to it; destinations people already have are kept. An
 * administrator only: the section above it already refuses anyone else.
 */
type ProviderName = 'deel' | 'wise'

export interface PayoutProviderSwitchesApi {
  listPayoutProviders?(args?: { signal?: AbortSignal }): Promise<{
    data: readonly { provider: ProviderName; enabled: boolean }[]
  }>
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

export const createPayoutProviderSwitches = (root: HTMLElement, api: PayoutProviderSwitchesApi) => {
  const toggles = [...root.querySelectorAll<HTMLInputElement>('[data-settings-provider-toggle]')]
  const result = root.querySelector<HTMLElement>('[data-settings-provider-result]')
  let signal: AbortSignal | null = null
  const say = (text: string): void => {
    if (result) result.textContent = text
  }

  for (const toggle of toggles) {
    toggle.addEventListener('change', async () => {
      const provider = toggle.dataset['settingsProviderToggle'] as ProviderName
      if (signal === null || api.setPayoutProviderEnabled === undefined) return
      try {
        await api.setPayoutProviderEnabled({
          provider,
          body: { enabled: toggle.checked },
          ...(signal === null ? {} : { signal }),
        })
        say(`${provider === 'deel' ? 'Deel' : 'Wise'} ${toggle.checked ? 'is now on' : 'is now off'} for payouts.`)
      } catch (error) {
        toggle.checked = !toggle.checked
        say(failure(error))
      }
    })
  }

  return {
    load: async (active: AbortSignal): Promise<void> => {
      signal = active
      if (api.listPayoutProviders === undefined) {
        root.hidden = true
        return
      }
      root.hidden = false
      try {
        const providers = await api.listPayoutProviders({ signal: active })
        for (const toggle of toggles) {
          toggle.checked =
            providers.data.find((row) => row.provider === toggle.dataset['settingsProviderToggle'])?.enabled === true
        }
        say('')
      } catch (error) {
        say(failure(error))
      }
    },
  }
}
