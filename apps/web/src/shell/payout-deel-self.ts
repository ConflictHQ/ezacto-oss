import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { setRequestBusy } from '../request-feedback.js'

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

const owners = new WeakMap<HTMLElement, object>()

export const wireDeelSelfPayout = (root: HTMLElement, api: DeelSelfPayoutApi, userId: number, signal = new AbortController().signal): void => {
  const summary = root.querySelector<HTMLElement>('[data-settings-payout-deel-summary]')
  const remove = root.querySelector<HTMLButtonElement>('[data-settings-payout-deel-remove]')
  const form = root.querySelector<HTMLFormElement>('[data-settings-payout-deel-form]')
  const result = root.querySelector<HTMLElement>('[data-settings-payout-deel-result]')
  if (!summary || !remove || !form || !result) return

  if (signal.aborted) return
  const owner = {}
  owners.set(root, owner)
  const current = () => owners.get(root) === owner && !signal.aborted
  let accountId: number | null = null
  let pending = false
  const setPending = (value: boolean): void => {
    pending = value
    for (const control of root.querySelectorAll<HTMLInputElement>('input,button')) control.disabled = value
    setRequestBusy(result, value)
  }
  setPending(false)
  signal.addEventListener('abort', () => {
    if (owners.get(root) === owner) setPending(false)
  }, { once: true })

  const load = async (): Promise<void> => {
    if (api.listPayoutProviders === undefined || api.listPayoutAccounts === undefined) {
      root.hidden = true
      return
    }
    try {
      const [providers, accounts] = await Promise.all([
        api.listPayoutProviders({ signal }),
        api.listPayoutAccounts({ id: userId, signal }),
      ])
      if (!current()) return
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
      if (!current()) return
      root.hidden = true
      result.textContent = failure(error)
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (api.linkPayoutAccount === undefined || pending || !current()) return
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim()
    if (email === '') return
    result.textContent = 'Saving…'
    setPending(true)
    try {
      await api.linkPayoutAccount({ id: userId, body: { provider: 'deel', external_id: email }, signal })
      if (!current()) return
      form.reset()
      result.textContent = 'Deel destination saved.'
      await load()
    } catch (error) {
      if (current()) result.textContent = failure(error)
    } finally {
      if (current()) setPending(false)
    }
  }, { signal })

  remove.addEventListener('click', async () => {
    if (accountId === null || api.detachPayoutAccount === undefined || pending || !current()) return
    setPending(true)
    result.textContent = 'Removing Deel destination…'
    try {
      await api.detachPayoutAccount({ id: accountId, signal })
      if (!current()) return
      result.textContent = 'Deel destination removed.'
      await load()
    } catch (error) {
      if (current()) result.textContent = failure(error)
    } finally {
      if (current()) setPending(false)
    }
  }, { signal })

  void load()
}
