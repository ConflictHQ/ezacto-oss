import { setRequestBusy } from '../request-feedback.js'
import type {
  CalendarConnection,
  CalendarConnectionApi,
  CalendarProvider,
  CalendarManualCleanup,
} from './model.js'

const providerName = (provider: CalendarProvider) =>
  provider === 'google' ? 'Google' : 'Microsoft'
const authorizationUrl = (provider: CalendarProvider, value: string): string => {
  const url = new URL(value)
  const host = provider === 'google' ? 'accounts.google.com' : 'login.microsoftonline.com'
  const validPath =
    provider === 'google'
      ? url.pathname === '/o/oauth2/v2/auth'
      : /^\/(?:common|organizations|consumers|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/oauth2\/v2\.0\/authorize$/.test(
          url.pathname,
        )
  if (
    !validPath ||
    url.hash ||
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Invalid calendar authorization destination')
  return url.href
}

export const createCalendarConnectionController = (
  root: HTMLElement,
  api: CalendarConnectionApi | undefined,
  host: { sessionFailure(error: unknown): boolean; navigate(url: string): void },
) => {
  const status = root.querySelector<HTMLElement>('[data-calendar-connections-status]')!
  const list = root.querySelector<HTMLElement>('[data-calendar-connections-list]')!
  const reload = root.querySelector<HTMLButtonElement>('[data-calendar-connections-reload]')!
  let controller: AbortController | null = null
  let detach = () => {}
  let busy = false
  let rows: CalendarConnection[] = []
  let cleanup: CalendarManualCleanup[] = []
  const current = (signal: AbortSignal) => controller?.signal === signal && !signal.aborted
  const setBusy = (value: boolean) => {
    busy = value
    setRequestBusy(status, value)
    for (const button of root.querySelectorAll<HTMLButtonElement>('button'))
      button.disabled = value || button.dataset.unavailable === 'true'
  }
  const render = () => {
    list.replaceChildren()
    if (!rows.length) {
      const empty = document.createElement('p')
      empty.textContent = 'Calendar connections are not configured on this instance.'
      list.append(empty)
    }
    for (const row of rows) {
      const section = document.createElement('section')
      section.dataset.calendarProvider = row.provider
      const actions = document.createElement('div')
      actions.className = 'calendar-connection-actions'
      const heading = document.createElement('h3')
      heading.textContent = providerName(row.provider)
      const detail = document.createElement('p')
      detail.textContent =
        row.cleanup_pending &&
        row.provider === 'microsoft' &&
        api?.manualCleanup &&
        cleanup.length === 0
          ? 'This cleanup requires the instance administrator; reconnect is unavailable until it is resolved.'
          : row.cleanup_pending
            ? 'Disconnected here. Provider cleanup is pending; review access in your provider account settings. Reconnect is unavailable until cleanup finishes.'
            : row.status === 'needs_reauth'
              ? 'Reconnect to restore calendar access.'
              : row.status === 'connected'
                ? row.syncing
                  ? 'Connected. Calendar sync is in progress.'
                  : 'Connected.'
                : 'Not connected.'
      section.append(heading, detail)
      if (row.last_synced_at && typeof row.last_synced_at === 'string') {
        const synced = document.createElement('p')
        const date = new Date(row.last_synced_at)
        synced.textContent = Number.isFinite(date.valueOf())
          ? `Last synced: ${date.toLocaleString()}`
          : 'Last sync time is unavailable.'
        section.append(synced)
      }
      if (row.last_error) {
        const error = document.createElement('p')
        error.textContent =
          'The last calendar check did not complete. Refresh or reconnect to try again.'
        section.append(error)
      }
      if (!row.available) {
        const unavailable = document.createElement('p')
        unavailable.textContent = 'This provider is currently unavailable on this instance.'
        section.append(unavailable)
      }
      const button = (
        text: string,
        action: 'authorize' | 'refresh' | 'disconnect',
        disabled: boolean,
      ) => {
        const control = document.createElement('button')
        control.type = 'button'
        control.className =
          action === 'authorize'
            ? 'primary-action'
            : action === 'disconnect'
              ? 'editor-secondary danger-action'
              : 'editor-secondary'
        control.textContent = text
        control.dataset.calendarAction = action
        control.dataset.unavailable = String(disabled)
        control.disabled = disabled || busy
        control.addEventListener('click', () => void run(action, row))
        actions.append(control)
      }
      if (row.status !== 'connected')
        button(
          row.status === 'needs_reauth' ? 'Reconnect' : 'Connect',
          'authorize',
          !row.available || row.cleanup_pending,
        )
      if (row.status === 'connected')
        button('Sync calendar', 'refresh', !row.available || row.syncing)
      if (row.status !== 'disconnected') button('Disconnect', 'disconnect', row.cleanup_pending)
      section.append(actions)
      if (row.provider === 'microsoft' && api?.confirmManualCleanup) {
        for (const item of cleanup) {
          const instructions = document.createElement('p')
          instructions.textContent =
            'Remove this app’s calendar permission in your Microsoft account before confirming. This records your confirmation; it does not verify removal with Microsoft.'
          section.append(instructions)
          for (const [label, href] of [
            ['Work or school account permissions', 'https://myapps.microsoft.com'],
            ['Personal account permissions', 'https://account.live.com/consent/Manage'],
          ]) {
            const link = document.createElement('a')
            link.textContent = label!
            link.href = href!
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
            section.append(link, document.createElement('br'))
          }
          const label = document.createElement('label')
          const check = document.createElement('input')
          check.type = 'checkbox'
          label.append(check, ' I removed this app’s calendar permission in Microsoft.')
          const confirm = document.createElement('button')
          confirm.type = 'button'
          confirm.className = 'primary-action'
          confirm.textContent = 'Record permission removal'
          confirm.disabled = true
          confirm.dataset.unavailable = 'true'
          check.addEventListener('change', () => {
            confirm.dataset.unavailable = String(!check.checked)
            confirm.disabled = busy || !check.checked
          })
          confirm.addEventListener('click', () => {
            if (check.checked) void run('confirm', row, item)
          })
          section.append(label, confirm)
        }
      }
      list.append(section)
    }
  }
  const read = async (signal: AbortSignal) => {
    const [result, obligations] = await Promise.all([
      api!.list(signal),
      api!.manualCleanup?.(signal) ?? Promise.resolve([]),
    ])
    if (!current(signal)) return false
    rows = result.data
    cleanup = obligations
    render()
    return true
  }
  const run = async (
    action: 'load' | 'authorize' | 'refresh' | 'disconnect' | 'confirm',
    row?: CalendarConnection,
    obligation?: CalendarManualCleanup,
  ) => {
    const signal = controller?.signal
    if (!api || !signal || !current(signal) || busy) return false
    setBusy(true)
    status.textContent =
      action === 'load'
        ? 'Loading calendar connections…'
        : action === 'authorize'
          ? `Opening ${providerName(row!.provider)} consent…`
          : action === 'refresh'
            ? `Syncing ${providerName(row!.provider)} calendar…`
            : action === 'confirm'
              ? 'Recording your permission-removal confirmation…'
              : `Disconnecting ${providerName(row!.provider)}…`
    let mutationFinished = false
    let navigating = false
    try {
      if (action === 'authorize') {
        const url = await api.authorize(row!.provider, row!.generation, signal)
        if (current(signal)) {
          host.navigate(authorizationUrl(row!.provider, url))
          navigating = true
        }
        return
      }
      if (action === 'refresh') await api.refresh(row!.provider, signal)
      if (action === 'confirm') await api.confirmManualCleanup!(obligation!, signal)
      if (action === 'disconnect') await api.disconnect(row!.provider, row!.generation, signal)
      mutationFinished = action !== 'load'
      if (!current(signal) || !(await read(signal))) return false
      status.textContent =
        action === 'load'
          ? ''
          : action === 'refresh'
            ? 'Calendar check finished. Review the connection status and your time-entry suggestions.'
            : action === 'confirm'
              ? 'Your permission-removal confirmation was recorded. Review the connection status below.'
              : 'Disconnected here. Review the provider cleanup status below.'
      return true
    } catch (error) {
      if (!current(signal) || host.sessionFailure(error)) return
      status.textContent = mutationFinished
        ? 'The operation finished, but connection status could not be refreshed. Refresh connections to check.'
        : action === 'load'
          ? 'Calendar connections could not be loaded. Try Refresh connections.'
          : 'The calendar operation could not be confirmed. Refresh connections before trying again.'
    } finally {
      if (current(signal) && !navigating) setBusy(false)
    }
  }
  const clear = () => {
    controller?.abort()
    controller = null
    detach()
    detach = () => {}
    rows = []
    cleanup = []
    list.replaceChildren()
    status.textContent = ''
    setBusy(false)
    root.hidden = true
  }
  reload.addEventListener('click', () => void run('load'))
  return {
    clear,
    activate(signal: AbortSignal, callbackResult?: string, callbackProvider?: string) {
      clear()
      if (!api || signal.aborted) return
      controller = new AbortController()
      const abort = () => clear()
      signal.addEventListener('abort', abort, { once: true })
      detach = () => signal.removeEventListener('abort', abort)
      root.hidden = false
      const owned = controller
      void run('load').then((loaded) => {
        if (!loaded || controller !== owned || owned.signal.aborted || signal.aborted) return
        if (callbackResult === 'admin_consent_required')
          status.textContent =
            'Your Microsoft tenant requires administrator approval. Contact your tenant administrator, then try connecting again.'
        if (callbackResult === 'failed')
          status.textContent =
            'Calendar connection was not completed. Refresh the connection status before trying Connect again.'
        if (callbackResult === 'connected')
          status.textContent = rows.some(
            (row) => row.status === 'connected' && row.provider === callbackProvider,
          )
            ? 'Calendar consent completed. Review the connection status below.'
            : 'Calendar setup returned. Review the connection status below.'
      })
    },
  }
}
