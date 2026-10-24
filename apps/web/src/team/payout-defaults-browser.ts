import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type { PayoutPreferenceRosterDto, PayoutProvidersApi } from './payout-providers-browser.js'

/**
 * Payment defaults on the team page (issue 1152): every person and the provider
 * their payouts use, with an administrator's override. An administrator sees the
 * whole list here; each row saves on its own, against the version it was read at.
 */
const label = (provider: string): string => (provider === 'deel' ? 'Deel' : 'Wise')

const failure = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    const body = error.body as { error?: { message?: string; fields?: { message?: string }[] } } | null
    return body?.error?.fields?.[0]?.message ?? body?.error?.message ?? 'That could not be saved. Try again.'
  }
  return 'That could not be saved. Try again.'
}

export const createPayoutDefaultsPanel = (root: HTMLElement, api: PayoutProvidersApi) => {
  const rows = root.querySelector<HTMLElement>('[data-team-defaults-rows]')
  const status = root.querySelector<HTMLElement>('[data-team-defaults-status]')
  if (!rows || !status) return { load: async () => {} }

  const load = async (signal: AbortSignal): Promise<void> => {
    if (api.listPayoutPreferences === undefined) {
      root.hidden = true
      return
    }
    root.hidden = false
    try {
      const { data } = await api.listPayoutPreferences({ signal })
      paint(data)
      status.textContent = ''
    } catch (error) {
      rows.replaceChildren()
      status.textContent = failure(error)
    }
  }

  const paint = (roster: PayoutPreferenceRosterDto): void => {
    rows.replaceChildren(
      ...roster.people.map((person) => {
        const row = document.createElement('tr')
        const name = document.createElement('td')
        name.textContent = person.name
        const held = document.createElement('td')
        held.textContent = person.linked_providers.length === 0 ? 'No account yet' : person.linked_providers.map(label).join(', ')
        const choice = document.createElement('td')
        const select = document.createElement('select')
        select.setAttribute('aria-label', `Default payment provider for ${person.name}`)
        const inherit = document.createElement('option')
        inherit.value = ''
        inherit.textContent = `Organization default (${label(roster.organization_default)})`
        select.append(inherit)
        for (const provider of person.linked_providers) {
          const option = document.createElement('option')
          option.value = provider
          option.textContent = label(provider)
          select.append(option)
        }
        select.value = person.provider ?? ''
        choice.append(select)
        const source = document.createElement('td')
        source.textContent =
          person.set_by === null
            ? 'Organization default'
            : person.set_by === 'automatic'
              ? 'Set on first link'
              : person.set_by === 'person'
                ? 'Chosen by them'
                : 'Set by an administrator'
        const action = document.createElement('td')
        const save = document.createElement('button')
        save.type = 'button'
        save.textContent = 'Save'
        save.addEventListener('click', async () => {
          save.disabled = true
          status.textContent = `Saving ${person.name}…`
          try {
            await api.setPayoutPreference!({
              id: person.user_id,
              provider: select.value === '' ? null : (select.value as 'deel' | 'wise'),
              expectedVersion: person.version,
            })
            status.textContent = `Saved for ${person.name}.`
            await load(new AbortController().signal)
          } catch (error) {
            status.textContent = failure(error)
          } finally {
            save.disabled = false
          }
        })
        action.append(save)
        row.append(name, held, choice, source, action)
        return row
      }),
    )
  }

  return { load }
}
