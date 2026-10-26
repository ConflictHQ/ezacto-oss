import type { EzactoClient } from '@conflict-hq/ezacto-client'
import type { StaffPaymentReport } from '@ezacto/core'

export type DeelPaymentStatusApi = Partial<Pick<EzactoClient, 'refreshDeelPaymentStatus'>>

export const createDeelPaymentStatusController = (
  page: HTMLElement,
  api: DeelPaymentStatusApi,
  refresh: (month: string, signal: AbortSignal) => Promise<void>,
) => {
  const message = page.querySelector<HTMLElement>('[data-deel-payment-refresh]')!
  let active: AbortSignal | null = null
  let month: string | null = null
  let generation = 0
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const schedule = (delay: number) => {
    cancelTimer()
    if (active && !active.aborted && month) timer = setTimeout(() => void poll(), Math.min(delay, 2_147_483_647))
  }
  const poll = async () => {
    const signal = active
    const requestedMonth = month
    const revision = generation
    if (!signal || signal.aborted || !requestedMonth || !api.refreshDeelPaymentStatus || busy) return
    if (document.hidden) { schedule(30_000); return }
    const current = () => active === signal && !signal.aborted && revision === generation
    busy = true
    message.hidden = false
    message.textContent = 'Checking payment status in Deel…'
    message.setAttribute('aria-busy', 'true')
    let delay = 30_000
    try {
      const response = await api.refreshDeelPaymentStatus({ body: { month: requestedMonth }, signal })
      if (!current()) return
      if (!response.data.configured) {
        message.textContent = 'Automatic Deel payment status is unavailable on this instance.'
        delay = 300_000
        return
      }
      await refresh(requestedMonth, signal)
      if (!current()) return
      message.textContent = response.data.failed > 0
        ? 'Some Deel statuses could not be checked. Showing the last confirmed status; retrying automatically.'
        : response.data.remaining > 0
          ? 'Updating payment status for the remaining Deel hours…'
          : 'Showing the latest confirmed Deel statuses. Checking automatically while this page is open.'
      if (response.data.remaining > 0) delay = 1_500
      delay = Math.max(delay, response.data.retry_after_ms ?? 0)
      if ((response.data.retry_after_ms ?? 0) >= 30_000) {
        message.textContent = 'Waiting before the next Deel status check. Showing the latest confirmed statuses.'
      }
    } catch {
      if (current()) message.textContent = 'Deel payment status could not be checked. Showing the last confirmed status; retrying automatically.'
    } finally {
      busy = false
      if (current()) {
        message.setAttribute('aria-busy', 'false')
        schedule(delay)
      } else if (active && !active.aborted && month) schedule(0)
    }
  }
  return {
    activate(signal: AbortSignal) {
      cancelTimer()
      generation++
      active = signal
      month = null
      message.hidden = true
      message.textContent = ''
      signal.addEventListener('abort', () => {
        if (active !== signal) return
        generation++
        cancelTimer()
        month = null
        message.hidden = true
        message.textContent = ''
        message.setAttribute('aria-busy', 'false')
      }, { once: true })
    },
    update(report: StaffPaymentReport) {
      const requestedMonth = report.rows.some(row => (row.deel_staging?.staged_entries ?? 0) > 0)
        ? report.month : null
      if (month !== requestedMonth) generation++
      month = requestedMonth
      cancelTimer()
      if (!month || !api.refreshDeelPaymentStatus) { message.hidden = true; return }
      schedule(0)
    },
  }
}
