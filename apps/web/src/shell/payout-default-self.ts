import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type { PayoutProvidersApi } from '../team/payout-providers-browser.js'

/**
 * "Where you are paid": the person's own default provider (issue 1152). Lists
 * the organization default and the providers they hold. Choosing one is theirs;
 * an administrator can override it on the team page.
 */
const label = (provider: string): string => (provider === 'deel' ? 'Deel' : 'Wise')

const failure = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    const body = error.body as { error?: { message?: string; fields?: { message?: string }[] } } | null
    return body?.error?.fields?.[0]?.message ?? body?.error?.message ?? 'That could not be saved. Try again.'
  }
  return 'That could not be saved. Try again.'
}

export const wirePayoutDefaultSelf = (root: HTMLElement, api: PayoutProvidersApi, userId: number): void => {
  const form = root.querySelector<HTMLFormElement>('[data-settings-payout-default-form]')
  const select = root.querySelector<HTMLSelectElement>('[data-settings-payout-default]')
  const result = root.querySelector<HTMLElement>('[data-settings-payout-default-result]')
  if (!form || !select || !result || api.getPayoutPreference === undefined) return

  let version = 0
  const load = async (): Promise<void> => {
    try {
      const { data } = await api.getPayoutPreference!({ id: userId })
      version = data.version
      select.replaceChildren()
      const inherit = document.createElement('option')
      inherit.value = ''
      inherit.textContent = `Organization default (${label(data.organization_default)})`
      select.append(inherit)
      for (const provider of data.linked_providers) {
        const option = document.createElement('option')
        option.value = provider
        option.textContent = label(provider)
        select.append(option)
      }
      select.value = data.provider ?? ''
      form.hidden = data.linked_providers.length === 0 && data.provider === null
      result.textContent = data.linked_providers.length === 0 ? 'Link an account below to choose where you are paid.' : ''
    } catch (error) {
      result.textContent = failure(error)
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (api.setPayoutPreference === undefined) return
    result.textContent = 'Saving…'
    try {
      await api.setPayoutPreference({
        id: userId,
        provider: select.value === '' ? null : (select.value as 'deel' | 'wise'),
        expectedVersion: version,
      })
      result.textContent = 'Saved. That is where you will be paid.'
      await load()
    } catch (error) {
      result.textContent = failure(error)
    }
  })

  void load()
}
